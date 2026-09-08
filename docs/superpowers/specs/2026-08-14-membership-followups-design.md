# Membership follow-ups from the AccessContext org-set work (PR #1762)

Three small, independent items promised in the #1762 review thread. No new features; each is a
cleanup or micro-optimization of the membership plumbing that PR introduced.

## 1. Request-scoped memoization of the membership set

### Problem

`organizationRepository.findMembershipOrgIds(user.id)` is resolved fresh on every call. Within a
single HTTP request it can run more than once: `toAccessContext` resolves it for every management
gate, and `resolveRetrievalLakeScope` passes the raw repository into
`dataLakeService.getDynamicDataLakeAccess`, which resolves it again internally. The entitlements
read on the same requests is already memoized per request (`req.entitlements ??=` in
`getRequestEntitlements`); membership deserves the same treatment.

### Change

New module `apps/client/server/dataLakes/requestMembership.ts`:

- `export interface MembershipRequest { user?: IUserDocument; membershipOrgIds?: string[] }` -
  the same minimal structural-request pattern as `EntitlementRequest` (and for the same
  cross-package-compilability reason; see the comment on `EntitlementRequest`).
- `export async function getRequestMembershipOrgIds(req: MembershipRequest): Promise<string[]>`:
  fail closed on a nullish user (return `[]`), else
  `return (req.membershipOrgIds ??= await organizationRepository.findMembershipOrgIds(req.user.id));`
  `??=` (not `||=`): an empty membership list is a valid result that must memoize.

Consumers:

- `toAccessContext` replaces its direct
  `organizationIds: await organizationRepository.findMembershipOrgIds(user.id)` with
  `organizationIds: await getRequestMembershipOrgIds(req)`.
- `resolveRetrievalLakeScope` replaces the raw `organizations: organizationRepository` adapter
  entry with a wrapper that serves the requesting user from the memo and anyone else (a
  defense-in-depth arm; the resolver only ever asks about `user.id` today) from the repository:

  ```ts
  organizations: {
    findMembershipOrgIds: (uid: string) =>
      uid === user.id ? getRequestMembershipOrgIds(req) : organizationRepository.findMembershipOrgIds(uid),
  },
  ```

Out of scope, deliberately:

- The completion/ToolContext path (chat knowledge tools): not an HTTP request; its resolvers get
  `db.organizations` from `ToolContext`, whose lifecycle differs. A per-turn cache there is its
  own change with its own invalidation questions.
- The Slack ingest path: one membership resolution per ingest; nothing to memoize.

### Tests

New `requestMembership.test.ts` (co-located): memoizes (two awaits -> one repository call);
empty-list result memoizes too (`??=` semantics); nullish user returns `[]` without a repository
call. Plus one `resolveRetrievalLakeScope` assertion that the wrapper serves `user.id` from the
memo (repository called at most once across `toAccessContext` + scope resolution when both run
on one request object).

## 2. Delete the dead `SlackIngestActor.organizationId`

`apps/client/server/slack/dataLakeIngestAuthz.ts:30` (the field moved here from
`dataLakeFileIngest.ts` when #1735 extracted the shared authz prologue). Since #1674 removed the
selected-org pointer from authorization, nothing reads it: zero production readers in the slack
modules; only three test fixtures still set it (`dataLakeFileIngest.test.ts`,
`handleDataLakeCommand.test.ts`, `dataLakeLinkIngest.test.ts`).

Change: remove the field from the interface and every fixture that sets it. The compiler
enumerates any reader this grep missed; if one exists, stop and report rather than adapting it.

## 3. One spelling for the membership predicate in `OrganizationModel`

Two methods encode "is a member via the users[] ACL" differently
(`packages/database/src/models/infra/admin/OrganizationModel.ts`):

- `search()` line ~341: `permissions: { $in: ['read'] }`
- `findMembershipOrgIds()` line ~407: `permissions: { $in: ['read', 'write'] }`

Change: one module-level constant above the schema,

```ts
// The users[] ACL permission values that constitute org membership. 'write' implies membership
// even when 'read' was never explicitly granted - the #1674 read-side set already treats it so,
// and search() must agree or a write-only member can reach an org they cannot find.
const MEMBER_PERMISSIONS = ['read', 'write'];
```

used by both call sites (`$in: MEMBER_PERMISSIONS`).

**Deliberate behavior change:** a member holding only `write` in their `permissions` array will
now match `search()`'s membership arm (previously invisible there while still passing every
#1674 read gate). This corrects a latent inconsistency, not preserves it.

### Tests

In the existing OrganizationModel/repository test suite (uses `createMongoServer()`): a
write-only member (a) appears in `search()` filtered by their userId, (b) appears in
`findMembershipOrgIds`. A user with no ACL entry matches neither.

## Out of scope

- Any change to `findIdsWithAdminRights`, `resolveActiveOrg` (write-target validation is
  deliberately wider than the read set - see its comment), or the shareable/groups arms.
- ToolContext-level membership caching (noted above).

## Verification

- `pnpm --filter @bike4mind/database test` (organization suites) and focused client vitest on
  the new/changed test files; `turbo:typecheck` before push.
