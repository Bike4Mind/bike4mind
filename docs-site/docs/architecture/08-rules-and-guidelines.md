---
title: Rules & Guidelines
description: The architectural rules that MUST be followed — Core knows nothing about infra/api, dependencies are interfaces, wire at startup.
sidebar_position: 9
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Rules & Guidelines

[← Back to README](./README.md)

<!-- SUMMARY -->
This document contains the architectural rules that MUST be followed.
Key rules: Core knows nothing about infra/api, dependencies are interfaces, wire at startup.
Import direction flows: apps → packages/infra → packages/core → packages/shared.
<!-- /SUMMARY -->

---

## The 3 Core Rules

<!-- RULES: These are non-negotiable -->

| Rule | What It Means |
|------|---------------|
| **Core knows nothing** | No imports from `infra/` or `api/` in `core/` |
| **Dependencies are interfaces** | Core depends on contracts, not implementations |
| **Wire at startup** | Connect implementations to core in `main.ts` or middleware |

---

## Import Direction

<!-- IMPORT-RULES: Validate imports against these rules -->

```
✅ Allowed:
apps/client/pages/api/    → @packages/core, @packages/shared
apps/client/pages/api/    → @packages/infra
apps/client/server/       → everything
apps/client/src/          → @packages/shared (only)
@packages/core            → @packages/shared
@packages/infra           → @packages/core, @packages/shared
@packages/infra/{feature} → @packages/infra/shared

❌ Forbidden:
@packages/core            → @packages/infra
@packages/core            → apps/
@packages/infra           → apps/
@packages/infra/{feature} → @packages/infra/{other-feature}
@packages/shared          → @packages/core, @packages/infra, apps/
```

### Visual Representation

```
                       ┌─────────────────┐
                       │ apps/client/    │
                       │   server/       │
                       └────────┬────────┘
                                │ wires everything
     ┌──────────────────────────┼──────────────────────────┐
     │                          │                          │
     ▼                          ▼                          ▼
┌───────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ apps/client/  │   │ packages/infra/ │   │ packages/core/  │
│   pages/api/  │   │                 │   │                 │
└───────┬───────┘   └────────┬────────┘   └────────┬────────┘
        │                    │                     │
        │                    │                     │
        └────────────────────┴─────────────────────┘
                         can import from
                              │
                              ▼
                   ┌─────────────────────┐
                   │  packages/shared/   │  ← No internal deps
                   │   (API types, Zod)  │
                   └─────────────────────┘
                              ▲
                              │
                   ┌──────────┴──────────┐
                   │   apps/client/src/  │
                   │    (frontend)       │
                   └─────────────────────┘
```

---

## Third-Party Libraries in Core

<!-- THIRD-PARTY: Guidelines for external npm packages -->

Not all external packages are "infrastructure." Distinguish between:

| Category | Examples | Needs Contract? | Use in Core? |
|----------|----------|-----------------|--------------|
| **Pure Utilities** | dayjs, lodash, uuid, zod | No | ✅ Yes |
| **Infrastructure** | mongoose, sendgrid, stripe, aws-sdk | Yes | ❌ No |
| **Non-Deterministic** | `Date.now()`, `Math.random()`, `crypto.randomUUID()` | Recommended | Via contract |

### Pure Utilities: Use Directly

Libraries that are **pure functions** (no I/O, no side effects, deterministic) can be imported directly in `packages/core/`:

```typescript
// packages/core/src/orders/Order.ts
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';

export class Order {
  get formattedDate(): string {
    return dayjs(this.createdAt).format('YYYY-MM-DD');
  }

  get daysUntilExpiry(): number {
    return dayjs(this.expiresAt).diff(dayjs(this.createdAt), 'days');
  }
}
```

**Why this is allowed:**
- No I/O or external system calls
- Deterministic (same input → same output)
- No reason to swap implementations
- Testing doesn't require mocking

### Non-Deterministic Functions: Abstract with Contract

Functions that return **different values each call** should be abstracted for testability:

| Function | Problem | Solution |
|----------|---------|----------|
| `new Date()` / `dayjs()` | "Now" changes | `Clock` contract |
| `Math.random()` | Non-deterministic | `RandomGenerator` contract |
| `crypto.randomUUID()` | Non-deterministic | `IdGenerator` contract |

#### Clock Contract

```typescript
// packages/core/src/shared/Clock.ts
export interface Clock {
  now(): Date;
}
```

```typescript
// packages/infra/src/shared/clock/SystemClock.ts
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

// packages/infra/src/shared/clock/FakeClock.ts (for testing)
export class FakeClock implements Clock {
  constructor(private currentTime: Date = new Date()) {}

  now(): Date {
    return this.currentTime;
  }

  advance(ms: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + ms);
  }
}
```

#### IdGenerator Contract

```typescript
// packages/core/src/shared/IdGenerator.ts
export interface IdGenerator {
  generate(): string;
}
```

```typescript
// packages/infra/src/shared/id/UuidGenerator.ts
import { v4 as uuid } from 'uuid';

export class UuidGenerator implements IdGenerator {
  generate(): string {
    return uuid();
  }
}

// packages/infra/src/shared/id/FakeIdGenerator.ts (for testing)
export class FakeIdGenerator implements IdGenerator {
  private counter = 0;

  generate(): string {
    return `test-id-${++this.counter}`;
  }
}
```

### Library Configuration

Configure plugins, locales, or global settings at the **entry point**, not in core:

```typescript
// apps/client/server/setup.ts or similar
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

// Configure once at startup
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('America/New_York');
```

| Configuration Type | Location |
|--------------------|----------|
| Library plugins | Entry point setup |
| Default locales | Entry point setup |
| Global settings | Entry point setup |

### Decision Flowchart

```
Is it a pure function (no I/O, deterministic)?
├── YES → Use directly in core
└── NO → Does it fetch current time, generate random values, or call external systems?
         ├── Current time/random → Create contract in core/shared/, implement in infra/shared/
         └── External system (DB, API, email) → Create contract, implement in infra/
```

### Common Libraries Reference

| Library | Category | Use in Core? |
|---------|----------|--------------|
| `dayjs` | Pure utility | ✅ Direct (except `dayjs()` for "now") |
| `lodash` | Pure utility | ✅ Direct |
| `zod` | Pure utility | ✅ Direct |
| `uuid` | Pure utility | ✅ Direct |
| `date-fns` | Pure utility | ✅ Direct |
| `decimal.js` | Pure utility | ✅ Direct |
| `mongoose` | Infrastructure | ❌ Contract required |
| `axios` | Infrastructure | ❌ Contract required |
| `@sendgrid/mail` | Infrastructure | ❌ Contract required |

---

## Folder Responsibilities

| Folder | Contains | Can Import From |
|--------|----------|-----------------|
| `packages/shared/` | API types, validation schemas, constants | External libs only |
| `packages/core/` | Domain objects, actions, contracts | `@packages/shared` |
| `packages/infra/shared/` | Shared infra (implements `core/shared/` contracts) | `@packages/core`, `@packages/shared` |
| `packages/infra/{feature}/` | Feature infra (implements `core/{feature}/` contracts) | `@packages/core`, `@packages/infra/shared` |
| `apps/client/pages/api/` | HTTP handlers, routes, validators | `@packages/core`, `@packages/infra`, `@packages/shared` |
| `apps/client/server/` | Server utilities, middleware | Everything |
| `apps/client/src/` | Frontend application | `@packages/shared` only |

### Infrastructure Placement Rule

**Follow the contract location** - implementation location mirrors contract location:

| Contract In | Implementation In |
|-------------|-------------------|
| `core/shared/` | `infra/shared/{technology}/` |
| `core/{feature}/` | `infra/{feature}/` |
| Infrastructure plumbing | `infra/shared/{technology}/` |
| Test fakes | `infra/{feature}/memory/` |

---

## Naming Conventions

<!-- NAMING-CONVENTIONS: Follow these patterns exactly -->

### Files

| Type | Pattern | Example |
|------|---------|---------|
| Entity | `{Name}.ts` | `Order.ts`, `User.ts` |
| Contract | `{Name}Repository.ts` | `OrderRepository.ts` |
| Action | `{verbNoun}.ts` | `createOrder.ts`, `cancelOrder.ts` |
| Feature Infra | `{Name}Repository{Provider}.ts` | `OrderRepositoryMongo.ts` |
| Shared Infra | `{Name}{Provider}.ts` | `SendGridMailer.ts` |
| Test Fake | `InMemory{Name}.ts` | `InMemoryOrderRepository.ts` |
| Validator | `{name}Validators.ts` | `orderValidators.ts` |

### Classes and Functions

| Type | Pattern | Example |
|------|---------|---------|
| Entity | PascalCase class | `class Order` |
| Contract | PascalCase interface | `interface OrderRepository` |
| Action | camelCase function | `function createOrder()` |
| Error | PascalCase + Error | `class NotFoundError` |

---

## Error Handling

See [Validation](./10-validation.md) for error types (`NotFoundError`, `BusinessError`, `InvariantError`) and where each is thrown.

---

## When to Add Complexity

Start simple. Add structure when you feel pain:

| Pain | Solution |
|------|----------|
| Multiple entry points (REST + CLI + Queue) | Separate `apps/` for each entry point |
| Complex domain with many entities | Add `packages/core/src/orders/domain/` subfolder |
| Shared types between features | Create `packages/core/src/shared/` |
| Shared types with frontend | Create `packages/shared/` ([details](./14-shared-package.md)) |
| Complex read requirements | Add queries folder and DTOs ([details](./11-cqrs-and-read-models.md)) |
| Need explicit use case boundaries | Extract use case classes |
| Complex error handling | Create `packages/core/src/shared/errors.ts` |
| Need transactions | Add `UnitOfWork` contract |
| 10+ actions in a feature | Group actions by subdomain |
| Feature outgrows folder | Promote to separate feature |

---

## Common Mistakes

<!-- ANTI-PATTERNS: Check code against these patterns -->

### 1. Putting business logic in API handlers

```typescript
// ❌ Bad - logic in handler
const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const order = new Order(...);
    if (order.items.length === 0) {
      return res.status(400).json({ error: 'Empty order' });
    }
    await OrderModel.create({ ... });
    await sendEmail(req.body.email, 'Order confirmed');
    res.json(order);
  });

// ✅ Good - handler calls action
const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error });
    }
    const order = await createOrder(deps, req.ctx, parsed.data);
    res.status(201).json({ id: order.id });
  });
```

### 2. Importing infrastructure in core

```typescript
// ❌ Bad - core knows about mongoose
// packages/core/src/orders/actions/createOrder.ts
import { OrderModel } from '@packages/infra/orders/models/OrderModel';  // NO!

// ✅ Good - core uses interface
// packages/core/src/orders/actions/createOrder.ts
import { OrderRepository } from '../OrderRepository';
```

### 3. Putting side effects in entities

```typescript
// ❌ Bad - entity sends email
class Order {
  async submit() {
    this.status = 'submitted';
    await sendEmail(this.customerEmail, 'Confirmed');  // NO!
  }
}

// ✅ Good - action handles side effects
async function createOrder(deps, input) {
  const order = new Order(...);
  order.submit();
  await deps.repository.save(order);
  await deps.mailer.send(input.email, 'Confirmed', '...');
}
```

### 4. Skipping validation layers

```typescript
// ❌ Bad - no input validation
const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const order = await createOrder(deps, req.ctx, req.body);  // Unsafe!
    res.json(order);
  });

// ✅ Good - validate before calling core
const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error });
    }
    const order = await createOrder(deps, req.ctx, parsed.data);
    res.json(order);
  });
```

---

## Anti-Pattern Detection Guide

<!-- ANTI-PATTERN-DETECTION: Use these patterns to identify and fix violations -->

This section provides machine-readable patterns for detecting architectural violations. Each anti-pattern includes detection criteria and remediation steps.

### AP-1: Infrastructure Import in Core

<!-- ANTI-PATTERN: AP-1 -->

**Detection Pattern:**
```
File location: packages/core/**/*.ts
Search for: import.*from.*@packages/infra
Search for: import.*from.*mongoose|mongodb|sendgrid|aws-sdk
```

**Violation Example:**
```typescript
// packages/core/src/orders/actions/createOrder.ts
import { OrderModel } from '@packages/infra/orders/models/OrderModel';  // ❌ VIOLATION
```

**Fix:** Create a contract interface in core, implement in infra.

---

### AP-2: Business Logic in Handler

<!-- ANTI-PATTERN: AP-2 -->

**Detection Pattern:**
```
File location: apps/client/pages/api/**/*.ts
Indicator: More than 5 lines between input validation and action call
Indicator: Database queries in handler
Indicator: Business conditionals (if customer.status, if order.total)
```

**Violation Example:**
```typescript
// apps/client/pages/api/orders/index.ts
const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const customer = await CustomerModel.findById(req.body.customerId);
    if (customer.status === 'suspended') {  // ❌ Business logic in handler
      return res.status(400).json({ error: 'Suspended' });
    }
    // ...more logic
  });
```

**Fix:** Move all business logic to action. Handler should only: validate input, call action, return response.

---

### AP-3: Side Effects in Entity

<!-- ANTI-PATTERN: AP-3 -->

**Detection Pattern:**
```
File location: packages/core/src/**/[A-Z]*.ts (Entity files)
Search for: await (inside class methods)
Search for: import.*Mailer|Logger|Repository
```

**Violation Example:**
```typescript
// packages/core/src/orders/Order.ts
class Order {
  async submit() {
    this.status = 'submitted';
    await sendEmail(this.customerEmail, 'Confirmed');  // ❌ Side effect
  }
}
```

**Fix:** Entity methods should be synchronous. Move side effects to action.

---

### AP-4: Missing Authorization Check

<!-- ANTI-PATTERN: AP-4 -->

**Detection Pattern:**
```
File location: packages/core/src/**/actions/*.ts
Function signature: (deps, ctx, input)
Missing: Policies.can or policy check in function body
```

**Violation Example:**
```typescript
// packages/core/src/orders/actions/cancelOrder.ts
export async function cancelOrder(deps, ctx, input) {
  const order = await deps.repository.findById(input.orderId);
  // ❌ Missing: OrderPolicies.canCancel(ctx, order) check
  order.cancel(input.reason);
  await deps.repository.save(order);
}
```

**Fix:** Add policy check after loading the entity, before business logic.

---

### AP-5: Cross-Feature Repository Import

<!-- ANTI-PATTERN: AP-5 -->

**Detection Pattern:**
```
File location: packages/core/src/{feature}/**/*.ts
Search for: import.*Repository.*from.*@packages/core/(?!{same-feature})
Search for: import.*from.*\.\.\/\.\.\/(?!shared)
```

**Violation Example:**
```typescript
// packages/core/src/orders/actions/createOrder.ts
import { CustomerRepository } from '../../customers/CustomerRepository';  // ❌ Cross-feature import
```

**Fix:** Use function dependencies instead (for both read AND write):
```typescript
export interface CreateOrderDeps {
  // Read from another feature
  getCustomer: (id: string) => Promise<CustomerData | null>;  // ✅ Function dependency
  // Write to another feature - also valid!
  updateQuest: (id: string, data: QuestUpdateData) => Promise<void>;  // ✅ Function dependency
}
```

---

### AP-5b: Cross-Feature Infra Import

<!-- ANTI-PATTERN: AP-5b -->

**Detection Pattern:**
```
File location: packages/infra/src/{feature}/**/*.ts
Search for: import.*from.*@packages/infra/(?!shared)(?!{same-feature})
```

**Violation Example:**
```typescript
// packages/infra/src/orders/OrderRepositoryMongo.ts
import { UserRepositoryMongo } from '../users/UserRepositoryMongo';  // ❌ Cross-feature infra import
```

**Fix:** Feature infra can only import from:
- `@packages/core` (contracts and domain objects)
- `@packages/infra/shared` (base classes, utilities)
- Same feature folder

---

### AP-6: Wrong Error Type

<!-- ANTI-PATTERN: AP-6 -->

**Detection Pattern:**
```
File location: packages/core/src/**/actions/*.ts
Check: NotFoundError thrown for business rule violations
Check: BusinessError thrown for missing resources
Check: InvariantError thrown outside entity
```

**Correct Usage:**
| Situation | Correct Error |
|-----------|---------------|
| Resource not in DB | `NotFoundError` |
| Business rule prevents action | `BusinessError` |
| Invalid state transition | `InvariantError` (in Entity only) |

---

### AP-7: Action Signature Violation

<!-- ANTI-PATTERN: AP-7 -->

**Detection Pattern:**
```
File location: packages/core/src/**/actions/*.ts
User action missing ctx: function.*\(deps.*input\).*Promise (without ctx)
System action with ctx: function system.*\(deps.*ctx.*input\)
```

**Correct Signatures:**
```typescript
// User action - MUST have ctx
export async function createOrder(deps, ctx, input): Promise<Order>

// System action - MUST NOT have ctx
export async function systemExpireOrders(deps, input): Promise<number>
```

---

### AP-8: Shared Package Importing Internal Packages

<!-- ANTI-PATTERN: AP-8 -->

**Detection Pattern:**
```
File location: packages/shared/**/*.ts
Search for: import.*from.*@packages/core
Search for: import.*from.*@packages/infra
```

**Violation:** `packages/shared/` should only contain types shared with frontend and must not import from core or infra.

**Fix:** Move the code to the appropriate package, or duplicate types if truly needed in both places.

---

### AP-9: Wiring Dependencies in Handlers

<!-- ANTI-PATTERN: AP-9 -->

**Detection Pattern:**
```
File location: apps/client/pages/api/**/*.ts
Search for: new.*RepositoryMongo\(
Search for: new.*Mailer\(
Search for: new.*Gateway\(
```

**Violation Example:**
```typescript
// apps/client/pages/api/orders/index.ts
const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const repository = new OrderRepositoryMongo();  // ❌ VIOLATION
    const mailer = new SendGridMailer(process.env.SENDGRID_KEY!);  // ❌ VIOLATION

    const order = await createOrder({ repository, mailer }, req.ctx, req.body);
    res.json(order);
  });
```

**Problems:**
| Issue | Impact |
|-------|--------|
| Connection pool per request | DB connection exhaustion under load |
| No singleton guarantees | Duplicated expensive resources |
| Testing difficulty | Can't inject fakes without module mocking |
| Fail on first request | Bad config discovered at runtime, not startup |

**Fix:** Wire dependencies in singleton container, inject into handlers:
```typescript
// apps/client/server/dependencies.ts
const orderRepository = new OrderRepositoryMongo();
const mailer = new SendGridMailer(process.env.SENDGRID_KEY!);

export function getOrderDeps() {
  return { repository: orderRepository, mailer };
}

// apps/client/pages/api/orders/index.ts
import { getOrderDeps } from '@server/dependencies';

const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const deps = getOrderDeps();  // ✅ Inject deps
    const order = await createOrder(deps, req.ctx, req.body);
    res.json(order);
  });
```

See [Entry Points - Wiring Dependencies](./06-entry-points.md#wiring-dependencies-in-maints) for complete examples.

---

### AP-11: Standalone Factory Functions in Infra

**Detection:** Functions like `createGetXxx(Model)` that return closures doing MongoDB queries.

**Why it's a problem:** Bypasses the Repository pattern, makes testing harder, and scatters data access logic.

**Fix:** Convert to a Repository class implementing a core contract.

---

### AP-12: Cross-Feature Types in Wrong Feature's Infra

**Detection:** Infra module imports types from another feature's core (e.g., `import { FileRepository } from '@packages/core/files'` inside `infra/projects/`).

**Why it's a problem:** Creates hidden coupling between features at the infrastructure layer.

**Fix:** Use function deps with locally-defined types. Wire at the entry point.

---

### AP-13: System Action Used for User-Initiated Operations

**Detection:** `system{Action}` called from user-facing entry points (API routes, queue processors handling user requests).

**Why it's a problem:** Skips authorization checks. Makes it unclear whether the action should enforce access control.

**Fix:** Convert to user action with AuthContext: `(deps, ctx, input)`.

---

### AP-14: Direct Cross-Feature Import in Core

**Detection:** `import { ... } from '../../other-feature/'` inside a core action.

**Why it's a problem:** Creates hidden coupling between features, bypasses DI.

**Fix:** Declare a function dep with local types; wire the source action at the entry point.

---

### Anti-Pattern Checklist

<!-- CHECKLIST-ANTI-PATTERNS: Run through this before committing -->

Before committing code, verify:

- [ ] No `@packages/infra` imports in `packages/core/`
- [ ] No database/external service imports in `packages/core/`
- [ ] Handlers only validate input and call actions
- [ ] No `await` in entity methods
- [ ] All user actions have authorization checks
- [ ] No cross-feature repository imports in core
- [ ] No cross-feature infra imports (only `@packages/infra/shared` allowed)
- [ ] Infra placement follows contract location (see Infrastructure Placement Rule)
- [ ] Correct error types used in correct layers
- [ ] User actions have `(deps, ctx, input)` signature
- [ ] System actions have `(deps, input)` signature (no ctx)
- [ ] `packages/shared/` has no internal imports
- [ ] No dependency construction in handlers (wire in server setup)

---

## Quick Reference

See the [Folder Structure](./README.md#folder-structure) in the README for the complete directory layout.

---

## The Mental Model

```
"My business logic is in packages/core/.
 It talks to the outside world through interfaces.
 Implementations live in packages/infra/.
 I wire them together at startup in each app's entry points."
```

That's the whole pattern.
