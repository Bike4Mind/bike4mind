# Membership Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three follow-ups promised in PR #1762: request-scoped memoization of the membership set, deletion of the dead `SlackIngestActor.organizationId`, and one shared spelling for the users[]-ACL membership predicate.

**Architecture:** Three independent tasks. Task 1 adds a `getRequestMembershipOrgIds` helper (the `req.entitlements ??=` pattern) and wires it into the two client-server call sites. Task 2 is a mechanical field deletion. Task 3 extracts a `MEMBER_PERMISSIONS` constant in `OrganizationModel` and aligns `search()` to it (deliberate behavior change for write-only members).

**Tech Stack:** TypeScript, vitest (client: mocked `@bike4mind/database`; database: real Mongo via `setupMongoTest()`/`createMongoServer()`).

## Global Constraints

- ASCII only on every added `.ts` line (CI-gated).
- Node 24 for every command: prefix with `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`.
- Client tests: NEVER `pnpm --filter @bike4mind/client test -- run <path>` (full 20-min suite). Only `pnpm --filter @bike4mind/client exec vitest run <path>`.
- Database tests must use the shared Mongo test utils (`setupMongoTest()` already wraps `createMongoServer()`), never `MongoMemoryServer.create()`.
- `??=` (never `||=`) for the memo: an empty list is a valid, non-nullish result that must memoize.
- Out of scope (do not touch): `findIdsWithAdminRights`, `resolveActiveOrg`, the shareable/groups arms, ToolContext-level caching, the Slack ingest deps.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Request-scoped membership memo + two call sites

**Files:**
- Create: `apps/client/server/dataLakes/requestMembership.ts`
- Create (test): `apps/client/server/dataLakes/requestMembership.test.ts`
- Modify: `apps/client/server/dataLakes/toAccessContext.ts` (the `organizationIds:` line, ~41)
- Modify: `apps/client/server/dataLakes/resolveRetrievalLakeScope.ts` (the `db:` adapter, ~95)
- Modify (test): `apps/client/server/dataLakes/resolveRetrievalLakeScope.test.ts` (assertions that pin `organizations: organizationRepository` verbatim)

**Interfaces:**
- Consumes: `organizationRepository.findMembershipOrgIds(userId: string): Promise<string[]>` (exists).
- Produces: `getRequestMembershipOrgIds(req: MembershipRequest): Promise<string[]>` and `interface MembershipRequest { user?: IUserDocument; membershipOrgIds?: string[] }` — no later task consumes them.

- [ ] **Step 1: Write the failing test**

Create `apps/client/server/dataLakes/requestMembership.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRequestMembershipOrgIds, type MembershipRequest } from './requestMembership';

const { mockFindMembershipOrgIds } = vi.hoisted(() => ({ mockFindMembershipOrgIds: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findMembershipOrgIds: mockFindMembershipOrgIds },
}));

describe('getRequestMembershipOrgIds', () => {
  beforeEach(() => {
    mockFindMembershipOrgIds.mockReset();
  });

  it('memoizes on the request object - two awaits, one repository call', async () => {
    mockFindMembershipOrgIds.mockResolvedValue(['org-1']);
    const req = { user: { id: 'u1' } } as unknown as MembershipRequest;
    expect(await getRequestMembershipOrgIds(req)).toEqual(['org-1']);
    expect(await getRequestMembershipOrgIds(req)).toEqual(['org-1']);
    expect(mockFindMembershipOrgIds).toHaveBeenCalledTimes(1);
    expect(mockFindMembershipOrgIds).toHaveBeenCalledWith('u1');
  });

  it('memoizes an empty set too (??= semantics, not ||=)', async () => {
    mockFindMembershipOrgIds.mockResolvedValue([]);
    const req = { user: { id: 'u1' } } as unknown as MembershipRequest;
    expect(await getRequestMembershipOrgIds(req)).toEqual([]);
    expect(await getRequestMembershipOrgIds(req)).toEqual([]);
    expect(mockFindMembershipOrgIds).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a nullish user without touching the repository', async () => {
    expect(await getRequestMembershipOrgIds({} as MembershipRequest)).toEqual([]);
    expect(mockFindMembershipOrgIds).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, verify it fails on the missing module**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/client exec vitest run server/dataLakes/requestMembership.test.ts`
Expected: FAIL - cannot resolve `./requestMembership`.

- [ ] **Step 3: Create `apps/client/server/dataLakes/requestMembership.ts`**

```ts
import type { IUserDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';

/**
 * Minimal structural request shape for the membership memo - the same pattern (and the same
 * cross-package-compilability reason) as `EntitlementRequest`; see the comment there.
 */
export interface MembershipRequest {
  user?: IUserDocument;
  membershipOrgIds?: string[];
}

/**
 * The caller's authoritative org-membership set (owner + users[] ACL - see
 * `organizationRepository.findMembershipOrgIds`, #1674), memoized per request the same way
 * `getRequestEntitlements` memoizes entitlement keys: resolved lazily on first use, cached on
 * `req.membershipOrgIds` so every later gate within the same request reuses the result.
 *
 * `??=` is correct here: an empty membership list is a valid, non-nullish result that must
 * memoize (`||=` would re-query on every org-less user's request).
 */
export async function getRequestMembershipOrgIds(req: MembershipRequest): Promise<string[]> {
  // Fail closed: a nullish user belongs to nothing.
  if (!req.user) return [];
  return (req.membershipOrgIds ??= await organizationRepository.findMembershipOrgIds(req.user.id));
}
```

- [ ] **Step 4: Run the test file, verify all 3 pass**

Same command as Step 2. Expected: PASS (3/3).

- [ ] **Step 5: Wire into `toAccessContext.ts`**

Replace (current text at ~lines 37-41):

```ts
    // Authoritative membership set (owner + users[] ACL), resolved per request - NOT
    // user.organizationId, the selected-org display preference (#1674). Resolved for admins
    // too: the fallback-lake org prerequisite and findBySlug's own-org preference apply to
    // admins as well, unlike the entitlement gates below.
    organizationIds: await organizationRepository.findMembershipOrgIds(user.id),
```

with:

```ts
    // Authoritative membership set (owner + users[] ACL), memoized per request by
    // getRequestMembershipOrgIds - NOT user.organizationId, the selected-org display
    // preference (#1674). Resolved for admins too: the fallback-lake org prerequisite and
    // findBySlug's own-org preference apply to admins as well, unlike the entitlement gates
    // below.
    organizationIds: await getRequestMembershipOrgIds(req),
```

Add the import `import { getRequestMembershipOrgIds } from './requestMembership';`. Keep the `organizationRepository` import - `administeredOrgIds` still uses it. If the current text differs from the block above, stop and report BLOCKED.

- [ ] **Step 6: Run the toAccessContext tests (mock already routes through `@bike4mind/database`)**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/client exec vitest run server/dataLakes/toAccessContext.test.ts`
Expected: PASS unchanged - the helper calls the same mocked `organizationRepository.findMembershipOrgIds`. If a test constructs one `req` and asserts two repository calls, update it to expect the memoized single call and note that in the report.

- [ ] **Step 7: Wire the wrapper into `resolveRetrievalLakeScope.ts`**

Replace:

```ts
  const scope = await dataLakeService.getDynamicDataLakeAccess({
    db: { dataLakes: dataLakeRepository, organizations: organizationRepository },
```

with:

```ts
  const scope = await dataLakeService.getDynamicDataLakeAccess({
    db: {
      dataLakes: dataLakeRepository,
      // The resolver derives membership itself from user.id; serve that lookup from the
      // request memo so one request resolves membership once across toAccessContext and this
      // scope. Any other id (defense-in-depth - the resolver only asks about user.id today)
      // falls through to the repository.
      organizations: {
        findMembershipOrgIds: (uid: string) =>
          uid === user.id
            ? getRequestMembershipOrgIds(req)
            : organizationRepository.findMembershipOrgIds(uid),
      },
    },
```

Add the import `import { getRequestMembershipOrgIds } from './requestMembership';`. `RetrievalScopeRequest` already extends `EntitlementRequest`, which is structurally assignable to `MembershipRequest`; if TypeScript rejects the `req` argument, intersect the local type (`type RetrievalScopeRequest = EntitlementRequest & MembershipRequest & { logger?: Logger }`) rather than casting.

- [ ] **Step 8: Update `resolveRetrievalLakeScope.test.ts` and add the memo-sharing assertion**

The existing assertions that pin the adapter verbatim (`db: { dataLakes: dataLakeRepository, organizations: organizationRepository }` at ~164, ~214, ~229) now fail. For each, replace the `organizations:` expectation with `organizations: expect.objectContaining({ findMembershipOrgIds: expect.any(Function) })` (keep the `dataLakes: dataLakeRepository` part).

Add one behavioral test in the same file (adapt the file's existing mock names for `getDynamicDataLakeAccess` and its captured call args; the repository mock object is the `__marker` stub, so give it a `findMembershipOrgIds` vi.fn for this test):

```ts
  it('serves the resolver membership lookup from the request memo (one repository call per request)', async () => {
    const req = makeReq(); // the file's existing request factory/shape for a plain user
    await resolveRetrievalLakeScope(req);
    const { db } = mockGetDynamicDataLakeAccess.mock.calls.at(-1)![0];
    req.membershipOrgIds = ['memoized-org'];
    await expect(db.organizations.findMembershipOrgIds(req.user!.id)).resolves.toEqual(['memoized-org']);
  });
```

(The exact factory/mock names differ in the file - read it first and keep its conventions. The assertion that matters: the captured wrapper, called with the requesting user's id, returns `req`'s memoized set without hitting the repository.)

- [ ] **Step 9: Run both scope test files**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/client exec vitest run server/dataLakes/resolveRetrievalLakeScope.test.ts server/dataLakes/requestMembership.test.ts server/dataLakes/toAccessContext.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/client/server/dataLakes/requestMembership.ts apps/client/server/dataLakes/requestMembership.test.ts apps/client/server/dataLakes/toAccessContext.ts apps/client/server/dataLakes/resolveRetrievalLakeScope.ts apps/client/server/dataLakes/resolveRetrievalLakeScope.test.ts
git commit -m "perf(client): memoize the membership org set per request

One HTTP request could resolve findMembershipOrgIds several times
(toAccessContext per gate, plus the retrieval-scope resolver's internal
lookup). Mirror the getRequestEntitlements pattern: lazy, cached on the
request object, empty list memoizes too.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Delete the dead `SlackIngestActor.organizationId`

**Files:**
- Modify: `apps/client/server/slack/dataLakeIngestAuthz.ts` (~line 30)
- Modify (fixtures): `apps/client/server/slack/handleDataLakeCommand.test.ts:23`, `apps/client/server/slack/dataLakeFileIngest.test.ts:22`, `apps/client/server/slack/dataLakeLinkIngest.test.ts:22`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing.

Since #1674 removed the selected-org pointer from authorization, no production code reads this field (verified by grep; the compiler re-verifies below). Only the three test fixtures set it.

- [ ] **Step 1: Remove the field**

In `dataLakeIngestAuthz.ts`, delete the line `  organizationId?: string;` from `SlackIngestActor` (between `tags?: string[] | null;` and `email?: string | null;`).

- [ ] **Step 2: Remove the fixture usages**

- `handleDataLakeCommand.test.ts:23`: `const actor = { id: 'u1', isAdmin: false, organizationId: 'org1' };` -> `const actor = { id: 'u1', isAdmin: false };`
- `dataLakeFileIngest.test.ts:22`: delete the `  organizationId: 'org-1',` line from the actor fixture.
- `dataLakeLinkIngest.test.ts:22`: delete the `  organizationId: 'org-1',` line from the actor fixture.

Do NOT touch `dataLakeFileIngest.test.ts:237-240` (asserts `params.organizationId` is undefined on the CREATED FILE - a different object, still meaningful) or the comment at `dataLakeLinkIngest.test.ts:185`.

- [ ] **Step 3: Typecheck the client - the compiler enumerates any reader the grep missed**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/client typecheck`
Expected: exit 0. If a production reader errors, STOP and report BLOCKED with the site.

- [ ] **Step 4: Run the three slack test files**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/client exec vitest run server/slack/handleDataLakeCommand.test.ts server/slack/dataLakeFileIngest.test.ts server/slack/dataLakeLinkIngest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/server/slack/dataLakeIngestAuthz.ts apps/client/server/slack/handleDataLakeCommand.test.ts apps/client/server/slack/dataLakeFileIngest.test.ts apps/client/server/slack/dataLakeLinkIngest.test.ts
git commit -m "chore(client): drop the dead SlackIngestActor.organizationId

Nothing has read it since authorization switched to the membership set;
only test fixtures still set it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: One membership-predicate spelling in `OrganizationModel`

**Files:**
- Modify: `packages/database/src/models/infra/admin/OrganizationModel.ts` (lines ~341 and ~407, plus a module constant)
- Test: `packages/database/src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: module-private `MEMBER_PERMISSIONS` (not exported).

- [ ] **Step 1: Write the failing test**

Append to `OrganizationModel.membershipOrgIds.test.ts` (reuse the file's existing `makeOrg` helper and `setupMongoTest()` import; add a second `describe` block):

```ts
describe('OrganizationRepository.search - users[] ACL membership arm', () => {
  setupMongoTest();

  const searchByUser = async (userId: string) =>
    (
      await organizationRepository.search('', { userId }, { page: 1, limit: 10 }, { field: 'name', direction: 'asc' })
    ).data.map(d => String(d._id));

  it('a write-only ACL member finds the org (same predicate as findMembershipOrgIds)', async () => {
    const org = await makeOrg('write-only-search', { users: [{ userId: 'u1', permissions: ['write'] }] });
    expect(await searchByUser('u1')).toEqual([String(org._id)]);
    // The read-side set must agree - the whole point of the shared constant.
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([String(org._id)]);
  });

  it('a user with no ACL entry and no ownership matches nothing', async () => {
    await makeOrg('unrelated', { users: [{ userId: 'someone', permissions: ['read'] }] });
    expect(await searchByUser('u1')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify the write-only case fails**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/database exec vitest run src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts`
Expected: the write-only test FAILS on the `search` assertion (current predicate is `$in: ['read']`); the no-entry test passes.

- [ ] **Step 3: Extract the constant and use it at both sites**

In `OrganizationModel.ts`, above the schema definition add:

```ts
// The users[] ACL permission values that constitute org membership. 'write' implies membership
// even when 'read' was never explicitly granted - the #1674 read-side set (findMembershipOrgIds)
// already treats it so, and search() must agree or a write-only member can reach an org they
// cannot find. Must stay the union used by BOTH call sites below.
const MEMBER_PERMISSIONS = ['read', 'write'];
```

Then:
- line ~341 (`search()`): `permissions: { $in: ['read'] }` -> `permissions: { $in: MEMBER_PERMISSIONS }`
- line ~407 (`findMembershipOrgIds()`): `permissions: { $in: ['read', 'write'] }` -> `permissions: { $in: MEMBER_PERMISSIONS }`

No other `permissions` site changes (line ~135 is a share-permission check, not membership).

- [ ] **Step 4: Run the full test file, verify all pass**

Same command as Step 2. Expected: PASS (existing membership tests + both new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/models/infra/admin/OrganizationModel.ts packages/database/src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts
git commit -m "fix(database): one spelling for the users[] membership predicate

search() said ['read'] while findMembershipOrgIds said ['read','write'],
so a write-only member passed every read gate yet could not find the org
in search. Shared MEMBER_PERMISSIONS constant; search now includes
write-only members (deliberate).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## After all tasks (orchestrator)

Full `pnpm turbo:typecheck` plus the touched suites before push. PR title suggestion:
`fix(data-lake): membership follow-ups - request memo, dead Slack field, one predicate spelling`.
