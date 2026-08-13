# AccessContext Organization Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lake authorization reads authoritative org membership (a set) instead of the selected-org pointer, in sync across the single gate, the listing query, and the retrieval resolver (issue #1674, spec: `docs/superpowers/specs/2026-08-13-accesscontext-org-set-design.md`).

**Architecture:** A new lean repository primitive (`findMembershipOrgIds`) turns the Organization documents' owner + `users[]` ACL into a normalized string-id set. The management `AccessContext` replaces `organizationId?: string` with `organizationIds: string[]`, resolved once per request in `toAccessContext` (already async). The retrieval context (`DataLakeAccessContext`) drops `user.organizationId` and gains a required `db.organizations` adapter; `getDynamicDataLakeAccess`/`getDataLakePrompts` resolve the set internally, so the chat pipeline's many construction sites only thread a repository. Removing the old fields makes the compiler enumerate every reader.

**Tech Stack:** TypeScript monorepo (pnpm + turbo), Mongoose/MongoDB, vitest (`setupMongoTest()` for DB tests), home-grown migration framework for the ensure-index migration.

## Global Constraints

- **Membership predicate** (one definition everywhere): user is the org's owner (`userId` field) OR appears in `users[]` with `permissions: { $in: ['read', 'write'] }`  -  the same arms `ShareableDocumentRepository.findAllAccessible` uses (minus the groups arm, which org membership deliberately does not include).
- **Ids are normalized strings** the moment they enter a context; empty array = member of no org.
- **Empty-set semantics:** only org-less (and public/owner/admin-reachable) lakes pass; an empty set must never widen access.
- **Access widening is intended:** a member of N orgs reads org lakes of all N. Removal from an org revokes immediately regardless of `user.organizationId`.
- The old fields are REMOVED (`AccessContext.organizationId`, `DataLakeAccessContext.user.organizationId`)  -  fix type fallout by threading the set/repository, never by loosening types or re-adding the pointer.
- The write path is untouched: `resolveActiveOrg` + `setLakeVisibility`'s single validated target org stay as they are.
- **No `index: true`** on fields; the new `{ 'users.userId': 1 }` index is declared via `schema.index()` at the bottom of OrganizationModel plus an ensure-index migration (precedent: `20260728000000_ensure-fabfilechunk-keyset-index.ts`).
- ASCII only on added lines; no `any` without documented reason; DB tests use `setupMongoTest()`.
- Node >= 24 for builds/typechecks: prefix commands with `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`. After editing `b4m-core/common`, run `pnpm --filter @bike4mind/common build` before dependent packages' tests. Run all commands in the foreground with large timeouts; never use background execution.
- Fresh worktree setup (once, before Task 1): `pnpm install && pnpm turbo:core:build`; afterwards revert lockfile churn with `git checkout -- pnpm-lock.yaml`.
- Focused tests: `pnpm --filter <pkg> exec vitest run <path>` (never `pnpm --filter @bike4mind/client test -- run <path>`).
- Conventional Commits; branch `fix/datalake-accesscontext-org-set` (already created).

---

### Task 1: `findMembershipOrgIds` + reverse-lookup index

**Files:**
- Modify: `b4m-core/common/src/types/entities/OrganizationTypes.ts` (inside `IOrganizationRepository`, near `findIdsAdministeredBy` at ~line 129)
- Modify: `packages/database/src/models/infra/admin/OrganizationModel.ts` (repository class ~line 169; index block ~line 162)
- Create: `packages/scripts/migrate/migrations/20260813000000_ensure-organization-member-index.ts`
- Modify: `packages/scripts/migrate/migrations/index.ts` (register the migration in `AvailableMigrations`, matching how neighbors are registered)
- Test: Create `packages/database/src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts`

**Interfaces:**
- Consumes: existing `OrganizationSchema` / `BaseRepository`.
- Produces: `organizationRepository.findMembershipOrgIds(userId: string): Promise<string[]>`  -  Tasks 2 and 3 call it; the same signature lands on `IOrganizationRepository`.

- [ ] **Step 0: Workspace setup (once per worktree)**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm install && PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm turbo:core:build && git checkout -- pnpm-lock.yaml`
Expected: install and core build succeed (missing premium overlay warning is benign).

- [ ] **Step 1: Write the failing test**

Create `packages/database/src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Organization, organizationRepository } from './OrganizationModel';
import { setupMongoTest } from '../../../__test__/utils';

const makeOrg = (name: string, extra: Record<string, unknown> = {}) =>
  Organization.create({ name, userId: 'someone-else', users: [], groups: [], ...extra });

describe('OrganizationRepository.findMembershipOrgIds', () => {
  setupMongoTest();

  it('returns orgs where the user is the owner', async () => {
    const owned = await makeOrg('owned', { userId: 'u1' });
    await makeOrg('other');
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([String(owned._id)]);
  });

  it('returns orgs where the user is in the users[] ACL with read permission', async () => {
    const member = await makeOrg('member-org', {
      users: [{ userId: 'u1', permissions: ['read'] }],
    });
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([String(member._id)]);
  });

  it('excludes an ACL row without read/write permission', async () => {
    await makeOrg('share-only', { users: [{ userId: 'u1', permissions: ['share'] }] });
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([]);
  });

  it('returns [] for a user in no org, and both arms together deduplicated', async () => {
    expect(await organizationRepository.findMembershipOrgIds('nobody')).toEqual([]);
    const both = await makeOrg('own-and-listed', {
      userId: 'u1',
      users: [{ userId: 'u1', permissions: ['read'] }],
    });
    expect(await organizationRepository.findMembershipOrgIds('u1')).toEqual([String(both._id)]);
  });
});
```

If `Organization.create` demands more required fields (check the schema's `required` fields and the existing `OrganizationModel.integration.test.ts` for the minimal valid shape), extend `makeOrg` accordingly  -  do not weaken the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/database exec vitest run src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts`
Expected: FAIL  -  `findMembershipOrgIds` is not a function.

- [ ] **Step 3: Implement**

In `b4m-core/common/src/types/entities/OrganizationTypes.ts`, inside `IOrganizationRepository` next to `findIdsAdministeredBy`:

```ts
  /**
   * IDs of every organization the user is a MEMBER of: the org's owner (`userId`) or a
   * `users[]` ACL row with read/write permission - the same membership arms
   * `shareable.findAllAccessible` grants on (groups deliberately excluded: org membership
   * is direct). Normalized strings, suitable for an `$in` filter. This is the authoritative
   * set lake authorization consumes (see AccessContext.organizationIds, #1674) - NOT
   * `user.organizationId`, which is a display preference.
   */
  findMembershipOrgIds(userId: string): Promise<string[]>;
```

In `packages/database/src/models/infra/admin/OrganizationModel.ts`, on `OrganizationRepository`:

```ts
  async findMembershipOrgIds(userId: string): Promise<string[]> {
    const docs = await this.organizationModel
      .find(
        {
          $or: [
            { userId },
            { users: { $elemMatch: { userId, permissions: { $in: ['read', 'write'] } } } },
          ],
        },
        { _id: 1 }
      )
      .lean();
    return docs.map(d => String(d._id));
  }
```

(Use the actual model property name the class uses  -  check its other methods; if the class's Mongoose model field is named differently, e.g. `this.model`, follow it.)

Index block at the bottom of the file (with the existing two):

```ts
// Backs findMembershipOrgIds' reverse lookup (users[] ACL by member) - previously every
// membership question collscanned. The owner arm rides the existing { userId: 1 } index.
OrganizationSchema.index({ 'users.userId': 1 });
```

Create `packages/scripts/migrate/migrations/20260813000000_ensure-organization-member-index.ts`:

```ts
import { Organization } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `{ 'users.userId': 1 }` exists on organizations.
 *
 * Lake authorization now resolves a caller's org-membership set on every data-lake request
 * (findMembershipOrgIds, #1674); without this index the users[] ACL arm collscans. Declared on
 * the schema too, but autoIndex builds lazily on a cold boot - a request-path dependency
 * belongs in a migration (same rationale as 20260728000000_ensure-fabfilechunk-keyset-index).
 *
 * Idempotent: createIndexes is a no-op for existing indexes; it also builds the two
 * pre-existing declared indexes if an environment somehow lacks them.
 */
const migration: MigrationFile = {
  id: 20260813000000,
  name: 'ensure organization member index',

  up: async () => {
    await Organization.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
```

Register it in `packages/scripts/migrate/migrations/index.ts` exactly the way the neighboring migrations are registered (import + entry in `AvailableMigrations`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/common build && PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/database exec vitest run src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/common typecheck && PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/database typecheck && PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/scripts typecheck`

```bash
git add b4m-core/common/src/types/entities/OrganizationTypes.ts packages/database/src/models/infra/admin/OrganizationModel.ts packages/database/src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts packages/scripts/migrate/migrations/20260813000000_ensure-organization-member-index.ts packages/scripts/migrate/migrations/index.ts
git commit -m "feat(database): org membership reverse lookup for lake authorization"
```

---

### Task 2: management side  -  `AccessContext.organizationIds` through gate, listing, and constructors

**Files:**
- Modify: `b4m-core/common/src/types/entities/DataLakeTypes.ts` (`AccessContext`, ~line 25)
- Modify: `b4m-core/services/src/dataLakeService/assertLakeAccess.ts` (`canAccessLake` ~line 67, `resolveFallbackLake` ~line 117, `assertLakeAccess` ~line 150)
- Modify: `packages/database/src/models/ai/DataLakeModel.ts` (`findAccessible` org constraint ~line 287; `findBySlug` ~line 144)
- Modify: `b4m-core/common/src/types/entities/DataLakeTypes.ts` `IDataLakeRepository.findBySlug` contract (search the interface for `findBySlug`)
- Modify: `apps/client/server/dataLakes/toAccessContext.ts`
- Modify: `apps/client/server/slack/dataLakeFileIngest.ts` (`buildSlackAccessContext` ~line 119; the `SlackLakeIngestDeps` type it Picks from; the site that constructs those deps  -  find via typecheck)
- Modify: `apps/client/pages/api/data-lakes/[id]/visibility.ts` (drop the local `toCtx`)
- Modify: `b4m-core/services/src/dataLakeService/getDataLakePrompts.ts` (`isTrustedForInjection`, ~line 100)  -  the actor side only; the retrieval-context side is Task 3
- Tests: `b4m-core/services/src/dataLakeService/dataLakeService.test.ts`, `packages/database/src/models/ai/DataLakeModel.test.ts`, `apps/client/server/dataLakes/toAccessContext.test.ts`, plus whatever typecheck surfaces

**Interfaces:**
- Consumes: `organizationRepository.findMembershipOrgIds(userId): Promise<string[]>` (Task 1).
- Produces: `AccessContext.organizationIds: string[]` (old `organizationId` gone); `findBySlug(slug: string, organizationIds?: string[])`; `findAccessible` org arm `{ organizationId: { $in: ctx.organizationIds } }`. Task 3 relies on the type being flipped.

- [ ] **Step 1: Write the failing gate tests**

In `b4m-core/services/src/dataLakeService/dataLakeService.test.ts`, locate the `canAccessLake` org cases (~lines 84-238); add to that describe (adapting the file's existing ctx-builder helpers  -  read them first; the shapes below show the required semantics):

```ts
it('grants an org lake to a member of that org regardless of any other memberships', () => {
  const lake = { createdByUserId: 'owner', organizationId: 'org-a', requiredUserTag: '', requiredEntitlement: '' };
  const ctx = { userId: 'u1', isAdmin: false, userTags: [], organizationIds: ['org-b', 'org-a'] };
  expect(dataLakeService.canAccessLake(lake as never, ctx as never)).toBe(true);
});

it('denies an org lake to a caller whose membership set does not include it (empty set included)', () => {
  const lake = { createdByUserId: 'owner', organizationId: 'org-a', requiredUserTag: '', requiredEntitlement: '' };
  expect(
    dataLakeService.canAccessLake(lake as never, { userId: 'u1', isAdmin: false, userTags: [], organizationIds: ['org-b'] } as never)
  ).toBe(false);
  expect(
    dataLakeService.canAccessLake(lake as never, { userId: 'u1', isAdmin: false, userTags: [], organizationIds: [] } as never)
  ).toBe(false);
});
```

(If the suite builds contexts through a helper, extend the helper to take `organizationIds` and keep the existing org cases compiling by migrating them from `organizationId: 'x'` to `organizationIds: ['x']`.)

- [ ] **Step 2: Write the failing listing test**

In `packages/database/src/models/ai/DataLakeModel.test.ts`, in the `findAccessible` org-scoping describe (~lines 44-300), add (again matching the file's existing seed/ctx helpers):

```ts
it('lists org lakes from EVERY org in the membership set', async () => {
  await makeLake({ name: 'a-lake', organizationId: 'org-a' });
  await makeLake({ name: 'b-lake', organizationId: 'org-b' });
  await makeLake({ name: 'c-lake', organizationId: 'org-c' });

  const lakes = await dataLakeRepository.findAccessible(ctxWith({ organizationIds: ['org-a', 'org-b'] }));

  const names = lakes.map(l => l.name).sort();
  expect(names).toContain('a-lake');
  expect(names).toContain('b-lake');
  expect(names).not.toContain('c-lake');
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/services exec vitest run src/dataLakeService/dataLakeService.test.ts` and the database equivalent for `DataLakeModel.test.ts`.
Expected: the new tests FAIL (organizationIds unread); pre-existing tests still pass.

- [ ] **Step 4: Flip the type**

In `b4m-core/common/src/types/entities/DataLakeTypes.ts`, replace `organizationId?: string;` on `AccessContext` with:

```ts
  /**
   * Authoritative org membership (normalized string ids), resolved at context construction
   * from the organization documents' owner + users[] ACL (findMembershipOrgIds) - never from
   * user.organizationId, which is the "currently selected org" display preference and must
   * not be an authorization input (#1674). Empty array = member of no organization.
   */
  organizationIds: string[];
```

Also update the `entitlementKeys` doc comment's sentence "this type also carries `userId`/`isAdmin`/`organizationId`" to name `organizationIds`.

- [ ] **Step 5: Update the gate and slug resolution**

`b4m-core/services/src/dataLakeService/assertLakeAccess.ts`:

- `canAccessLake` line ~67 becomes:

```ts
  // Org is a hard prerequisite when the lake is org-scoped - evaluated BEFORE the
  // tag/entitlement any-of so a non-member can never pass. Membership is the SET the
  // context resolved from the org ACLs (#1674); the lake side still normalizes because
  // a hydrated lake doc can carry an ObjectId.
  if (lakeOrgId && !ctx.organizationIds.includes(lakeOrgId)) return false;
```

- `resolveFallbackLake` line ~117 becomes:

```ts
  if (configOrgId && !ctx.organizationIds.includes(configOrgId)) return null;
```

- `assertLakeAccess` line ~150: `db.dataLakes.findBySlug(lakeIdOrSlug, ctx.organizationIds)`.

`packages/database/src/models/ai/DataLakeModel.ts` `findBySlug` becomes:

```ts
  async findBySlug(slug: string, organizationIds?: string[]): Promise<IDataLakeDocument | null> {
    // Slug is unique per (organizationId, slug). Prefer a lake in one of the caller's own
    // orgs, then fall back to an org-less lake with the same slug. Sorted so two own-org
    // matches resolve deterministically rather than by document order.
    if (organizationIds && organizationIds.length > 0) {
      const own = await this.dataLakeModel
        .findOne({ slug, organizationId: { $in: organizationIds } })
        .sort({ organizationId: 1 });
      if (own) return own.toJSON() as IDataLakeDocument;
    }
    const orgless = await this.dataLakeModel.findOne({ slug, organizationId: { $in: [null, ''] } });
    return (orgless?.toJSON() as IDataLakeDocument) ?? null;
  }
```

Mirror the new signature on `IDataLakeRepository.findBySlug` in `DataLakeTypes.ts` and fix every other `findBySlug` caller typecheck surfaces (pass a set or omit).

- [ ] **Step 6: Update the listing query**

`findAccessible`'s org constraint (~line 287) becomes:

```ts
    // Org constraint: lake has no org OR the lake's org is one the caller is a MEMBER of.
    const orgConstraint =
      ctx.organizationIds.length > 0
        ? { $or: [{ organizationId: { $in: [null, ''] } }, { organizationId: { $in: ctx.organizationIds } }] }
        : { organizationId: { $in: [null, ''] } };
```

- [ ] **Step 7: Update the constructors**

`apps/client/server/dataLakes/toAccessContext.ts`:

```ts
import type { AccessContext } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { getRequestEntitlements, type EntitlementRequest } from '@server/entitlements';
```

and the body:

```ts
export async function toAccessContext(req: EntitlementRequest): Promise<AccessContext> {
  const user = req.user!;
  const isAdmin = !!user.isAdmin;
  return {
    userId: user.id,
    isAdmin,
    userTags: user.tags ?? [],
    // Authoritative membership set (owner + users[] ACL), resolved per request - NOT
    // user.organizationId, the selected-org display preference (#1674). Resolved for admins
    // too: the fallback-lake org prerequisite and findBySlug's own-org preference apply to
    // admins as well, unlike the entitlement gates below.
    organizationIds: await organizationRepository.findMembershipOrgIds(user.id),
    entitlementKeys: isAdmin ? [] : await getRequestEntitlements(req),
  };
}
```

Update the file's header comment: the `#1109` normalization note becomes a note about the membership set. Keep the "ONE place" contract sentence.

`apps/client/server/slack/dataLakeFileIngest.ts`: widen the deps Pick with a membership resolver and use it:

```ts
export async function buildSlackAccessContext(
  actor: SlackIngestActor,
  deps: Pick<SlackLakeIngestDeps, 'resolveEntitlementKeys' | 'resolveMembershipOrgIds'>
): Promise<AccessContext> {
  const isAdmin = !!actor.isAdmin;
  return {
    userId: actor.id,
    isAdmin,
    userTags: actor.tags ?? [],
    organizationIds: await deps.resolveMembershipOrgIds(actor.id),
    entitlementKeys: isAdmin ? [] : await deps.resolveEntitlementKeys(actor),
  };
}
```

Add `resolveMembershipOrgIds: (userId: string) => Promise<string[]>` to `SlackLakeIngestDeps` (find its declaration in the same module tree) and wire the construction site (typecheck will point at it) to `organizationRepository.findMembershipOrgIds`.

`apps/client/pages/api/data-lakes/[id]/visibility.ts`: delete the local `toCtx`; instead:

```ts
import { toAccessContext } from '@server/dataLakes/toAccessContext';
...
    const activeOrg = await resolveActiveOrg(req, organizationId);
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, { db: { dataLakes: dataLakeRepository } });
    dataLakeService.assertLakeWritable(lake);

    const result = await dataLakeService.setLakeVisibility(
      // The promotion TARGET stays the per-request validated active org - a write input,
      // not an authorization read (#1674 keeps the write path as-is).
      { userId: ctx.userId, isAdmin: ctx.isAdmin, organizationId: activeOrg },
      lake.id,
      visibility,
      { db: { dataLakes: dataLakeRepository } }
    );
```

(Adjust the import path to however sibling routes import `toAccessContext`.)

`b4m-core/services/src/dataLakeService/getDataLakePrompts.ts` `isTrustedForInjection` (actor side):

```ts
function isTrustedForInjection(
  lake: Pick<IDataLakeDocument, 'createdByUserId' | 'organizationId'>,
  actor: { userId?: string; organizationIds?: string[] }
): boolean {
  if (actor.userId && lake.createdByUserId && String(lake.createdByUserId) === actor.userId) return true;
  const lakeOrg = normalizeId(lake.organizationId);
  return !!lakeOrg && (actor.organizationIds ?? []).includes(lakeOrg);
}
```

Update its callers within the file to pass `organizationIds` (in Task 2 that may mean threading from the context field that Task 3 renames  -  if this file will not compile until Task 3's context change, move ONLY this `isTrustedForInjection` edit into Task 3 and note it in your report; do not leave the branch uncompilable at commit time).

- [ ] **Step 8: Sweep the type fallout**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/common build && PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm turbo:typecheck`

Every error is a reader/constructor of the old field: migrate each to `organizationIds` (constructors resolve or thread the set; readers do set membership). Known fallout beyond the files above: `toAccessContext.test.ts` (its normalization tests become membership-resolution tests  -  mock `@bike4mind/database`'s `organizationRepository.findMembershipOrgIds`), `resolveAccessibleLakes.test.ts`, the archived/deleted list views, and any service test building an `AccessContext` literal. Do not loosen types; do not re-introduce a singular org field.

- [ ] **Step 9: Update and extend the affected suites; run them**

Migrate existing org cases (`organizationId: 'x'` -> `organizationIds: ['x']`) preserving each test's intent. Add the spec's behavior cases where they own the behavior:
- gate: "pointer-at-B member-of-A" is now simply `organizationIds: ['org-a', 'org-b']` reading an org-A lake (Step 1 covers it) plus a `toAccessContext` test proving the context is built from `findMembershipOrgIds(user.id)` and NOT from `user.organizationId` (mock the repo to return `['org-a']` while `user.organizationId` is `'org-b'`; assert `ctx.organizationIds` is `['org-a']`).
- removal revocation: gate test with `organizationIds: []` against an org lake (Step 1 covers the deny).

Run: the services, database, and client (`apps/client/server/dataLakes`) suites touched:
`PATH=... pnpm --filter @bike4mind/services exec vitest run src/dataLakeService/dataLakeService.test.ts`
`PATH=... pnpm --filter @bike4mind/database exec vitest run src/models/ai/DataLakeModel.test.ts`
`PATH=... pnpm --filter @bike4mind/client exec vitest run server/dataLakes/toAccessContext.test.ts server/dataLakes/resolveAccessibleLakes.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A b4m-core packages/database apps/client
git commit -m "fix(data-lake): management access context carries the org membership set"
```

---

### Task 3: retrieval side  -  resolver-internal membership

**Files:**
- Modify: `b4m-core/services/src/dataLakeService/getDynamicDataLakeTags.ts` (`DataLakeAccessContext` ~lines 32-53; `getDynamicDataLakeAccess` ~lines 111-145)
- Modify: `b4m-core/services/src/dataLakeService/getDataLakePrompts.ts` (org resolution ~line 101, `isTrustedForInjection` callers)
- Modify: `packages/database/src/models/ai/DataLakeModel.ts` (`findActiveByUserTagsAndEntitlements` ~lines 189-252) + its `IDataLakeRepository` contract
- Modify: `apps/client/server/dataLakes/resolveRetrievalLakeScope.ts` (~line 96)
- Modify: `b4m-core/services/src/llm/tools/base/types.ts` (`ToolContext.db.organizations` Pick, ~line 107)
- Modify: whatever `turbo:typecheck` surfaces as `DataLakeAccessContext`/`ToolContext` construction sites (known: `apps/client/pages/api/data-lakes/semantic-search.ts`, `b4m-core/services/src/llm/ChatCompletionFeatures.ts`, `ChatCompletionProcess.ts`, chat ToolContext builders, `semanticDataLakeSearch.ts`)
- Tests: `b4m-core/services/src/dataLakeService/getDynamicDataLakeTags.test.ts`, `getDataLakePrompts.test.ts`, `apps/client/server/dataLakes/resolveRetrievalLakeScope.test.ts`, `packages/database/src/models/ai/DataLakeModel.test.ts` (the `findActiveByUserTagsAndEntitlements` cases)

**Interfaces:**
- Consumes: `findMembershipOrgIds` (Task 1); flipped `AccessContext` (Task 2, for `isTrustedForInjection` if deferred there).
- Produces: `DataLakeAccessContext` with `db.organizations: Pick<IOrganizationRepository, 'findMembershipOrgIds'>` and NO `user.organizationId`; `findActiveByUserTagsAndEntitlements(userTags, entitlementKeys, organizationIds?: string[] | null, userId?: string | null)`.

- [ ] **Step 1: Write the failing resolver test**

In `b4m-core/services/src/dataLakeService/getDynamicDataLakeTags.test.ts` (read its existing mock context builder first; it mocks `db.dataLakes`), add:

```ts
it('resolves the membership set via db.organizations and passes it to the collection query', async () => {
  const findActive = vi.fn().mockResolvedValue([]);
  await getDynamicDataLakeAccess({
    db: {
      dataLakes: { findActiveByUserTagsAndEntitlements: findActive } as never,
      organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue(['org-a', 'org-b']) },
    },
    user: { id: 'u1', tags: [] },
    entitlementKeys: [],
  } as never);
  expect(findActive).toHaveBeenCalledWith([], [], ['org-a', 'org-b'], 'u1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/services exec vitest run src/dataLakeService/getDynamicDataLakeTags.test.ts`
Expected: the new test FAILS.

- [ ] **Step 3: Implement the context + resolver change**

`getDynamicDataLakeTags.ts`  -  `DataLakeAccessContext`:

- `db` gains `organizations: Pick<IOrganizationRepository, 'findMembershipOrgIds'>;` (required  -  an absent resolver would silently drop org lakes).
- `user` loses `organizationId`; update the interface doc comment: membership is resolved internally from `user.id`, `user.organizationId` was the selected-org pointer and is no longer an input (#1674).

`getDynamicDataLakeAccess` (~line 123): replace `const organizationId = normalizeId(context.user.organizationId);` with:

```ts
  const userId = context.user.id ? String(context.user.id) : undefined;
  // Authoritative membership (owner + users[] ACL), resolved here so every construction site
  // of this context - the chat tools, the retrieval scope, semantic search - cannot disagree
  // about what "my orgs" means (#1674). Id-less callers are members of nothing.
  const organizationIds = userId ? await context.db.organizations.findMembershipOrgIds(userId) : [];
```

and pass `organizationIds` to `findActiveByUserTagsAndEntitlements` (keeping the 4-arg order `userTags, entitlementKeys, organizationIds, userId`).

`getDataLakePrompts.ts` (~line 101): same replacement (`organizationIds` resolved from `context.db.organizations` / `userId`), thread into its `findActiveByUserTagsAndEntitlements` call and into `isTrustedForInjection` (whose set-based form lands here if Task 2 deferred it).

- [ ] **Step 4: Widen the collection method**

`DataLakeModel.ts` `findActiveByUserTagsAndEntitlements`: parameter `organizationId?: string | null` becomes `organizationIds?: string[] | null`; the two org uses become:

```ts
    const memberOrgIds = organizationIds ?? [];
    // Gateless org lake arm:
    if (memberOrgIds.length > 0) {
      nonOwnerArms.push({
        $and: [
          { $or: [{ requiredUserTag: null }, { requiredUserTag: '' }] },
          { $or: [{ requiredEntitlement: null }, { requiredEntitlement: '' }] },
          { organizationId: { $in: memberOrgIds } },
        ],
      });
    }
    ...
    const orgConstraint =
      memberOrgIds.length > 0
        ? { $or: [{ organizationId: null }, { organizationId: '' }, { organizationId: { $in: memberOrgIds } }] }
        : { $or: [{ organizationId: null }, { organizationId: '' }] };
```

Mirror the widened signature on the `IDataLakeRepository` contract. Add a DB test in `DataLakeModel.test.ts`'s `findActiveByUserTagsAndEntitlements` describe: a gateless lake in org-a and one in org-b are BOTH returned for `organizationIds: ['org-a', 'org-b']`, and neither for `[]`.

- [ ] **Step 5: Update the app seams and thread the repository**

`resolveRetrievalLakeScope.ts` (~line 96): drop the `organizationId` line from `user`, add `organizations` to the db adapter:

```ts
  const scope = await dataLakeService.getDynamicDataLakeAccess({
    db: { dataLakes: dataLakeRepository, organizations: organizationRepository },
    user: { id: user.id, tags: user.tags ?? [] },
    entitlementKeys,
    logger: req.logger,
  });
```

`b4m-core/services/src/llm/tools/base/types.ts` (~line 107): `organizations?: Pick<IOrganizationRepository, 'findById'>` widens to `organizations: Pick<IOrganizationRepository, 'findById' | 'findMembershipOrgIds'>` (required). Then run:

`PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/common build && PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm turbo:typecheck`

and fix every surfaced construction site by threading the organizations repository (apps side: `organizationRepository` from `@bike4mind/database`; core side: whatever adapter object the caller already receives). Never make the field optional to silence an error; if a genuine construction site has no repository access, STOP and report BLOCKED with the site.

- [ ] **Step 6: Update and run the affected suites**

- `getDynamicDataLakeTags.test.ts`: existing org cases move from `user.organizationId` to a mocked `db.organizations.findMembershipOrgIds`; the normalization-of-org-id tests become obsolete on the user side (the set is strings by contract)  -  repurpose them to assert the resolver passes the set through unchanged.
- `getDataLakePrompts.test.ts`: same treatment; `isTrustedForInjection` org case becomes set-membership.
- `resolveRetrievalLakeScope.test.ts` (~lines 153-237): the org-normalization-at-the-seam tests (#1343) become "threads `organizationRepository` and no longer forwards `user.organizationId`".

Run:
`PATH=... pnpm --filter @bike4mind/services exec vitest run src/dataLakeService/getDynamicDataLakeTags.test.ts src/dataLakeService/getDataLakePrompts.test.ts`
`PATH=... pnpm --filter @bike4mind/database exec vitest run src/models/ai/DataLakeModel.test.ts`
`PATH=... pnpm --filter @bike4mind/client exec vitest run server/dataLakes/resolveRetrievalLakeScope.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A b4m-core packages/database apps/client
git commit -m "fix(data-lake): retrieval resolvers read org membership, not the selected org"
```

---

### Task 4: full verification

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm turbo:typecheck`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" VITEST_MAX_WORKERS=2 pnpm turbo:test`
Expected: PASS. Known flakes in untouched packages (`artifactElision` perf, `retry` HTTP-date timing) pass in isolation  -  retry the failing file alone before treating it as real.

- [ ] **Step 3: Lint**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm lint:check`
Expected: clean.

- [ ] **Step 4: Commit anything the verification forced**

Only if Steps 1-3 forced fixes; `fix(data-lake): ...` describing the actual fix.
