# AccessContext Carries an Organization Set - Design

**Issue:** #1674 (lane C of the Data Lakes productization epic #1658). Self-contained correctness
fix; deliberately independent of the membership relation (#1667, landed as `DataLakeAccessGrant`
in #1720, which nothing reads yet) and of grant resolution at read time (#1673).

## Problem

Lake authorization reads `user.organizationId` - the "currently selected organization" pointer,
whose own type comment says it is not membership (`UserTypes.ts:364-368`). Authoritative org
membership is the organization document's `users[]` ACL plus the owner `userId`
(`OrganizationModel.ts:58-61` marks `users[]` AUTHORITATIVE).

Failure mode: grant a user read to org A's lakes. Any path that adds them to org B (`addMember`
overwrites the pointer unconditionally, invite acceptance, partner rules) silently evaporates
every org-A grant with no revocation event. The reverse also holds: removal from an org does not
revoke lake access unless that org happened to be the selected one.

A second divergence: writes and reads use different notions of "my org". The write path takes
the client-supplied active-switcher org and authorization-validates it per request
(`resolveActiveOrg`); the read path trusts the persisted pointer. The two disagree whenever the
switcher selection is not the last-written membership.

## Design

### 1. Membership primitive

`IOrganizationRepository.findMembershipOrgIds(userId: string): Promise<string[]>` - a lean query
returning the ids of every organization where the user is the owner (`userId` field) OR appears
in the `users[]` ACL with read permission. Same membership predicate as the generic
`shareable.findAllAccessible` (owner OR `$elemMatch` on `users` with read), but projected to
`_id` only and returned as normalized strings.

Index: `OrganizationSchema.index({ 'users.userId': 1 })` - today the reverse lookup collscans
(only `{userId: 1}` and `{managerId: 1}` exist). Declared at the bottom of the schema per repo
rules, plus an ensure-index migration following the `20260728000000_ensure-fabfilechunk-keyset-index`
precedent so existing deploys get it without relying on autoIndex.

### 2. AccessContext type change

`b4m-core/common/src/types/entities/DataLakeTypes.ts`: `organizationId?: string` is REMOVED and
replaced by:

```ts
  /**
   * Authoritative org membership (normalized ids), resolved at context construction from the
   * organization documents' owner + users[] ACL - never from user.organizationId, which is a
   * display preference ("currently selected org") and must not be an authorization input.
   * Empty array = member of no organization.
   */
  organizationIds: string[];
```

Removing the old field (not deprecating it) makes the compiler enumerate every reader; nothing
can keep consuming the pointer silently.

### 3. Context construction (three sites, one resolver)

- `apps/client/server/dataLakes/toAccessContext.ts` stays "the ONE place" the management
  context is built but becomes async: `toAccessContext(user, { db }): Promise<AccessContext>`,
  resolving `organizationIds` via `findMembershipOrgIds` once per request. All ~14 route call
  sites gain an `await` and pass the repository.
- `buildSlackAccessContext` (`apps/client/server/slack/dataLakeFileIngest.ts`) resolves the same
  way for the resolved Slack actor.
- The retrieval context is different: `DataLakeAccessContext` is constructed all over the chat
  pipeline (ToolContext is passed to the resolver wholesale), so the set is resolved INSIDE
  `getDynamicDataLakeAccess`/`getDataLakePrompts` from `user.id` via a new required
  `db.organizations: Pick<IOrganizationRepository, 'findMembershipOrgIds'>` adapter on the
  context. Construction sites (including `resolveRetrievalLakeScope`) just thread the
  repository and stop forwarding `user.organizationId`.

Admins get their set resolved like everyone else; admin bypasses stay where they are today (in
the gate and the collection query), not in construction.

The write path is untouched: `resolveActiveOrg` keeps validating the client-supplied target org
per request, and `setLakeVisibility`'s narrow actor type keeps carrying that single validated
org as the promotion TARGET (a write input, not an authorization-read input). The
`visibility.ts` route builds its `AccessContext` through the shared async `toAccessContext`
and passes the validated active org to the service separately.

### 4. The three read paths (in sync)

- **Single gate** - `canAccessLake` (`assertLakeAccess.ts`): the org prerequisite becomes
  set membership: `if (lakeOrgId && !ctx.organizationIds.includes(lakeOrgId)) return false;`.
  Same change in `resolveFallbackLake`'s org compare. Ids on the context are pre-normalized;
  `lakeOrgId` keeps its existing `normalizeId`.
- **Collection query** - `DataLakeModel.findAccessible`: the org constraint becomes
  `{ $or: [{ organizationId: { $in: [null, ''] } }, { organizationId: { $in: ctx.organizationIds } }] }`,
  collapsing to the no-org arm when the set is empty. Same shape in
  `findActiveByUserTagsAndEntitlements`, whose `organizationId` parameter widens to
  `organizationIds: string[]`.
- **Retrieval resolver** - `getDynamicDataLakeAccess` (`getDynamicDataLakeTags.ts`): its
  context loses `user.organizationId`; the resolver derives `organizationIds` internally
  (section 3) and threads it to the widened collection method. An id-less caller resolves to
  the empty set.

Fourth, minor reader: `getDataLakePrompts`'s `lakeOrg`/`actorOrg` disclosure compare moves to
the same set-membership rule so prompt disclosure cannot disagree with the gate.

### 5. Intended behavior change

Access WIDENS by design: a member of N organizations can read the org lakes of all N, not just
the currently selected one. Adding a user to a new org no longer revokes anything; removal from
an org revokes that org's lake access immediately regardless of the pointer. This is the
correctness fix the issue names, not a side effect. Org lakes in production currently number
zero (epic measurement), so the blast radius of the widening is nil today; the fix is about
being correct before #1667/#1672 make org lakes real.

### 6. Testing

Update the org cases in the suites the exploration enumerated: `dataLakeService.test.ts`
(gate), `DataLakeModel.test.ts` (collection query), `getDynamicDataLakeTags.test.ts`
(retrieval), `toAccessContext.test.ts`, `resolveRetrievalLakeScope.test.ts`,
`resolveAccessibleLakes.test.ts`, `getDataLakePrompts.test.ts`.

New cases, each at the level that owns the behavior:
- member of two orgs reads both orgs' lakes (gate + listing + retrieval);
- pointer at org B while a member of org A: org-A lake still readable (the evaporation bug);
- removed from the org: access denied even while the pointer still names it (silent-revocation
  gap closed);
- empty membership set: only no-org lakes pass;
- `findMembershipOrgIds`: owner-only, ACL-member, non-member, and normalization (real Mongo via
  `setupMongoTest()`).

### 7. Out of scope

- Reading `DataLakeAccessGrant` into any authorization decision (#1673).
- Owner-facing membership views (#1672), org-manageable lakes / succession (#1668).
- Any UI change; the org switcher and `user.organizationId` writers stay as they are.
- Entitlement/tag arms of the gate and queries - untouched.
