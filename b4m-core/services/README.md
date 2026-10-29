# Bike4Mind Services Documentation

## Overview

This directory contains the core business logic services for the B4M application. Each service is organized into its own module and follows specific patterns for consistency and maintainability.

## Media admission adapter migration

`ImageGenerationService`, `ImageEditService`, `CreateVideoJobDeps` and
`CreateMusicJobDeps` require an `assertModelAdmission` callback. The image services accept
`(user: string | IUserDocument, modelId, adminRoleWithheld?)`; their workers pass the loaded user.
Video/music job callbacks accept `(userId: string, modelId, adminRoleWithheld?)`.
Implement it with the shared `createModelAdmission` rule and the caller's current
entitlements. Preserve a withheld admin role when the third argument is true; it
is trusted caller metadata, never a request-body option. Propagate refusals before reserving credits or dispatching provider
work. Image services check both invocation and queue execution.

The Free-Tier Model Gate now applies to all model IDs, including media. Add approved
media IDs to `freeTierAllowedModels` in Admin Settings to offer them to free accounts;
the default list contains text models only. Conversational voice uses the billing
identifier `elevenlabs`; its text reasoning model must also be allowed. A refusal
uses `model_requires_subscription`. Check the allowlist and the account's paid-plan
entitlement when diagnosing an unexpected refusal; plan-read outages return a
retryable error instead of an upgrade prompt.

Media tool hosts must supply `getEntitlements: () => Promise<string[]>` through
`ToolBuilderConfig`, `ToolBuilderDeps` or `generateTools`' object argument. Proactive message
adapters require the same callback. Resolve the executing user's current entitlements and let
read failures reject; `entitlementKeys` remains a retrieval snapshot, not a model admission
source. A missing or failed resolver returns a retryable refusal when plan verification is needed.

## Internal user notes migration

`userService.adminUpdateUser` no longer accepts `userNotes`. Existing inline notes
remain read-only; remove that field from service calls. In the web application,
use the JWT-only `/api/admin/users/<userId>/notes` routes for versioned note
creation and edits. Reads require `support:read`, writes require `users:moderate`,
and impersonated sessions cannot write notes. These routes are not API-key endpoints.

## Workspace session settings migration

`IChatCompletionServiceOptions` and the adapters for `forkSession`, `snipSession`,
`cloneSession`, and `moveSession` now require `workspaceSessionSettings`. Pass the
host's contributed `WorkspaceSessionSettingsTable`, or `{}` when the host has no
contributions. Omitting the table is a configuration error rather than an opt-out.

`createSession` keeps this adapter optional for existing workspace-specific callers.

## Staged signup grants and assessment

`userService.evaluateSignupRisk` is a pure, server-owned evaluator exported from
`@bike4mind/services`. `releaseSignupTranche` runs it inside the grant transaction,
using the private `signupGrantRiskPolicy` setting (disabled by default).
For example, explicit disablement preserves a caller's validated entitlement:

```typescript
import { userService } from '@bike4mind/services';

const decision = userService.evaluateSignupRisk({ enabled: false }, {}, signupCredits);
```

`userService.assessSignupGrant` takes policy, observation, atomic-commit, and
band-telemetry adapters. The commit adapter must persist the assessment and grant
changes atomically and return the stored winner on retries. Callers remain
responsible for existing-account, paid, and staff exemptions; this helper does
not implement them. The staged engine enrolls only newly created eligible accounts;
existing accounts and explicit invite allocations retain their legacy grant path.

`releaseSignupTranche` persists `signupGrantAssessment`, the ledger, balance, and
released stage atomically. Every positive payout also claims the same canonical-inbox
entitlement used by legacy default grants inside that transaction. An inbox already
claimed by another account receives no payout; zero-credit tranches wait until the
first positive unlock to claim. A failed payout rolls the claim back for retry.
The assessment is admin-only and excluded from self,
public, and WebSocket responses. `collectRiskSignals`, when supplied by a trusted
server integration, receives the persisted user. Without it, only persisted signup
datacenter metadata is known; other observations remain unknown, never clean.
An invalid policy or missing required observation releases zero initial credits.

`unlockSignupGrant` accepts server-owned validators. A validator may return `true`
to authorize the configured maximum, `false` to refuse, or
`{ cumulativeCredits }` for an identity-specific cumulative entitlement bounded by
the account's snapshotted signup plus unlock credits. The engine grants only
`max(0, cumulativeCredits - creditsReleased)`. A validator may also return
`{ unlockedOrgId }` to authorize the maximum and record the vouching organization
on the grant; the org invite validator reserves a slot on the organization inside
the payout transaction, capped at its current `seats`. Its durable lifetime counter
survives account deletion and rolls back with a failed payout, so seat churn and
concurrent unlocks cannot exceed the cap. Replays, weaker evidence, and
different reasons cannot stack grants. Stronger evidence can release the remaining
delta. Grant stage records money released, not current identity trust or revocation.
Identity consumers own verification, identity deduplication, and revocation.

Activity checks use persisted successful chat turns stamped at creation by a
session-authenticated server invocation for an enrolled account. A retry through
an API key or an internal caller clears that provenance. Imported, legacy, API-key,
pending, and failed turns do not qualify. Private message/day thresholds are disabled by zero;
distinct UTC days must also span the corresponding elapsed whole days. The
first-party eligibility-check endpoint and Billing status provide a retryable path.
Organization invitation unlocks have their own `signupGrantOrgInviteEnabled` rollout
flag, disabled by default. Each organization can unlock at most its seat count
over its lifetime; removing a member or deleting a recipient account does not
replenish this budget. When enabled, Billing checks also retry persisted
accepted organization invitations, so a failed credit release after successful
acceptance remains recoverable after the invite leaves the pending inbox, even when
activity unlocks are disabled.
Card and phone integrations must supply their own trusted validators; declaring a
reason does not enable a verification flow. Admin releases require an audit writer.
The admin HTTP route rejects grants to the acting admin or their original account
under impersonation, matching the existing credit-adjustment policy.

If a grant is held with `status: 'unavailable'`, check for the `[signup-risk]`
assessment warning and inspect policy validity. A thrown observation collector
instead warns that the grant remains pending for retry and rolls back the tranche;
a transient infrastructure failure never becomes a permanent assessment.
Missing required observations instead appear in the decision's `missing` array.
Telemetry failures warn after commit and do not fail the grant. Diagnostics
contain no raw policy, network observations, or collector error contents.

The web integration supplies network counts, blocked/disposable domain observations
(including refreshed lists), and prior canonical-inbox entitlement collisions.
Collision means another account already claimed that inbox's default grant, not
merely that an alias account exists. The unique entitlement claim remains the
concurrency guard. Domain lookup failures keep the assessment pending for retry.
Only a real, server-verified Turnstile pass is carried through signed OTC tokens
or browser-bound OAuth state and stored in `signupMeta` before the first grant.
Skipped checks, public test secrets, fail-open outages and legacy accounts leave
the challenge observation unknown. Account-age, first-key and early-spend signals
remain in the separate young-account rescorer; future activity cannot be known at
the initial grant.

Admins can find zero-credit assessments through Users > High risk (the Risk filter),
then inspect the signup assessment's score, matched signals and missing observations
on the user profile. The existing signup grant unlock action requires an audit
reason and admin access. It releases the configured maximum, including
the verification tranche; it is not an initial-tranche-only override. The separate
young-account risk review queue does not replace this grant assessment surface.

### Private cohort replay

Run the same pure grant evaluator against privately labeled observations before
enabling or tuning a production policy:

```bash
pnpm --filter @bike4mind/scripts exec tsx src/replaySignupRisk.ts /private/path/signup-risk.json
```

The input has `policy` (an enabled `signupRiskPolicySchema` policy) and a `samples`
array. Each sample has `cohort` (`suspected` or `legitimate`), `signupCredits` and
`signals` (the observations understood by `evaluateSignupRisk`). Use observations
available at grant time, anchor network windows at signup, and leave unavailable
facts absent or null. Do not substitute zero for missing historical counts or
infer a challenge pass from a successful signup. Keep labels independent of the
candidate policy to avoid evaluating it against its own decisions.

The command performs no database writes and prints only aggregate band and
missing-observation counts for each cohort. Keep input files, actual weights,
sample identities and calibration results outside this public repository. Compare
the suspected cohort's reduced/review share and the legitimate cohort's full share
against privately agreed acceptance targets. Synthetic tests establish behavior,
not real-world accuracy; a private replay is still required for that claim.

Before enabling staging, retire existing quest subscriptions, restart subscriber
fanout, and reconnect clients so every live stream uses the new private-field
exclusions. Fanout persists subscription projections and does not rebuild an
already-running stream when its projection changes; a pre-deployment stream can
otherwise include activity provenance. Keep staging disabled until this rollout
step is complete.

`authEventRepository.recentDistinctSignups` in `@bike4mind/database` only accepts
windows within the retained history and ending no later than the current time.
Unavailable network metadata and saturated scans return `null`, not a clean zero;
query failures propagate so the collector can treat them as unavailable.

## Directory Structure

```
services/
├── someService/
│   ├── index.ts                # Exports all operations
│   ├── create.ts               # Create operation
│   ├── create.test.ts          # Tests for create operation
│   ├── update.ts               # Update operation
│   ├── update.test.ts          # Tests for update operation
│   └── [other-operations].ts   # Additional operations + corresponding tests
├── __tests__/
│   └── utils/
│       └── testUtils.ts        # Shared test utilities (e.g., mock creation)
└── index.ts                    # Root exports for all services
```

## Service Operation Pattern

### 1. File Components

Each operation consists of two files:

- Main operation file (e.g., `create.ts`)
  - Schema definition (using Zod)
  - Types definition
  - Adapters interface
  - Main operation functo
- Test file (e.g., `create.test.ts`)
  - Test suite for the operation
  - Mock setups
  - Test cases

### 2. Standard Code Structure

```typescript
// 1. Imports
import { IRepository } from '@b4m-core/common';
import { secureParameters } from '@b4m-core/utils';
import { z } from 'zod';

// 2. Schema Definition
const operationSchema = z.object({
  // Define parameters using Zod
});

type OperationParameters = z.infer<typeof operationSchema>;

// 3. Adapters Interface
interface OperationAdapters {
  db: {
    someRepo: IRepository;
  };
}

// 4. Main Function Export
export const operation = async (
  user: string | IUserDocument,
  params: OperationParameters,
  adapters: OperationAdapters
) => {
  // Implementation
};
```

## Testing Structure

### 1. Test File Location

- Test files (`*.test.ts`) are co-located with their corresponding operation files within the service directory (e.g., `someService/create.ts` and `someService/create.test.ts`).
- Shared testing utilities are placed in the root `__tests__/utils/` directory.

### 2. Test File Pattern (using Vitest)

```typescript
// 1. Imports (vitest, operation, mocks, types)
import { describe, it, expect, beforeEach, Mock } from 'vitest';
import { operation } from './operation'; // Adjust path as needed
import { createMockRepository } from '../__tests__/utils/testUtils'; // Adjust path as needed
import { IRepository, IUserDocument } from '@b4m-core/common'; // Example types

describe('serviceModule - operation', () => {
  // 2. Common variables and types
  const userId = 'test-user-id'; // Example user ID
  let mockRepo: IRepository; // Use specific repo type
  let adapters: { db: { specificRepo: IRepository } }; // Match operation's adapter structure

  // 3. Setup mocks before each test
  beforeEach(() => {
    mockRepo = createMockRepository(); // Use specific mock creator
    adapters = {
      db: {
        specificRepo: mockRepo, // Assign mock to correct adapter property
      },
    };
    // Reset mocks if necessary: (mockRepo.someMethod as Mock).mockClear();
  });

  // 4. Test cases using Arrange-Act-Assert (AAA) pattern
  it('should handle successful operation', async () => {
    // Arrange
    const params = {/* valid parameters */};
    const expectedResult = {/* expected outcome */};
    // Configure mock return values: (mockRepo.someMethod as Mock).mockResolvedValueOnce(expectedResult);

    // Act
    const result = await operation(userId, params, adapters);

    // Assert
    expect(result).toEqual(expectedResult);
    // Verify mock calls: expect(mockRepo.someMethod).toHaveBeenCalledWith(/* expected arguments */);
  });

  it('should handle validation errors', async () => {
    // Arrange
    const invalidParams = {/* invalid parameters */};

    // Act & Assert
    await expect(operation(userId, invalidParams, adapters)).rejects.toThrow(
      /* Optional: Specific error type or message */
    );
  });

  // Add more tests for other scenarios (error handling, edge cases, access control)
});
```

### 3. Test Coverage Requirements

Each operation should include tests for:

- Happy path (successful operation)
- Parameter validation
- Error handling
- Access control (if applicable)
- Edge cases

### 4. Mock Utilities

- Use `__tests__/utils/testUtils.ts` for common mock creation functions (e.g., `createMockUserRepository`).
- Follow repository interface contracts defined in `@b4m-core/common`.

## Implementation Guidelines

### 1. Parameter Validation

- Use `secureParameters` for input validation
- Define schemas using Zod
- Export schema if needed by other operations

### 2. Access Control

- Use repository shareable methods
- Verify entity existence and accessibility
- Include proper error handling

### 3. Error Handling

- Use custom error classes from @b4m-core/utils
- Common errors:
  - NotFoundError: Entity not found
  - UnauthorizedError: User lacks permission
  - ValidationError: Invalid input

### 4. Data Updates

- Update updatedAt timestamp when modifying entities
- Use immutable patterns for array updates
- Perform atomic operations through repositories

### 5. Repository Usage

- Access database through repository interfaces
- Use specialized repository methods
- Define repository interfaces in @b4m-core/common

## Creating New Features

1. Create operation file with descriptive name
2. Create corresponding test file
3. Follow the standard code structure
4. Implement required validations
5. Add comprehensive tests
6. Export in service's index.ts
7. Export service in root index.ts

## Best Practices

1. **Code Organization**
   - Keep operations focused and single-purpose
   - Document complex logic with comments
   - Use TypeScript features for type safety

2. **Testing**
   - Follow AAA pattern (Arrange, Act, Assert)
   - Mock external dependencies
   - Test both success and failure cases
   - Maintain test isolation

3. **Type Safety**
   - Use TypeScript interfaces
   - Leverage Zod for runtime validation
   - Maintain type consistency in tests

4. **Documentation**
   - Add JSDoc comments for complex functions
   - Document non-obvious test scenarios
   - Keep README updated with new patterns

## Why This Pattern?

1. **Decoupling**: Services are independent of external configurations
2. **Testability**: Easy to mock dependencies and test logic
3. **Maintainability**: Consistent structure makes code predictable
4. **Type Safety**: Strong typing with TypeScript and Zod
5. **Access Control**: Built-in security through repository patterns

## Usage Example

```typescript
// Server API implementation
import { someOperation } from '@b4m-core/services';
import { Repository } from 'models';

router.post('/endpoint', async (req, res) => {
  const result = await someOperation(req.user.id, req.body, {
    db: {
      repository: Repository,
    },
  });

  res.json(result);
});
```
