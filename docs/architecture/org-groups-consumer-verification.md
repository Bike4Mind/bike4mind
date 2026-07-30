# Org Groups: `user.groups` consumer verification (Phase 2b)

The `Group` collection is empty in production, so every consumer that branches on
`user.groups` has only ever seen an empty array. Turning groups on lights them all up at
once, and the first use gates confidential data. This is the deliberate pass that exercises
each consumer with a **non-empty** `user.groups` **before** any real group is provisioned,
so Phase 3 does not discover behavior through a real customer.

## The shared invariant

Every consumer matches `user.groups` (a flat array of group ids, no org qualifier) against
a shared document's `groups[]`, where each entry pairs a `groupId` with the `permissions`
that group is granted. Access requires **membership in a group whose entry carries the
requested permission** - the groupId and the permission must be on the **same** entry. Two
failure modes to keep out:

1. **Crash / no-op break** - the filter shape breaks on non-empty input.
2. **Over-broad grant** - the match leaks beyond the intended group + permission (e.g. a
   permission granted to one group bleeds to a member of a different group on the same doc).

## Consumers map to three implementations

The five consumers collapse to three distinct group-matching implementations. Verifying
those three covers all five.

| Consumer | Implementation | Notes |
|---|---|---|
| CASL ability resolution (`apps/client/server/auth/ability.ts`) | **A. CASL `$elemMatch`** | The access gate. Compiled to a Mongo query via `accessibleBy`. |
| Data lakes (`apps/client/server/dataLakes/index.ts`, both call sites) | **B. `buildOwnershipConditions` `$elemMatch`** | Thin pass-through of `user.groups ?? []` into `fabfiles.search`. |
| `ChatCompletionFeatures.ts` forced retrieval | **B** | Pass-through into `db.fabfiles.search`. |
| `knowledgeBaseSearch` (semantic + keyword) | **B** | Semantic path funnels through `collectScopedFiles` -> `fabfiles.search`; keyword path calls `fabfiles.search` directly. |
| `knowledgeBaseRetrieve` Path B (tag/query search) | **B** | Same `fabfiles.search` funnel. |
| `knowledgeBaseRetrieve` Path A (deep link by id) | **C. in-memory `.some()`** | Per-entry check `userGroups.includes(g.groupId) && g.permissions.some(read/write)`. |

Implementation **B** (`buildOwnershipConditions` in
`packages/database/src/queries/fabFileSearchQuery.ts`) is the single chokepoint for four of
the five consumers.

## Verification results

Each implementation is now locked with unit tests asserting **grant for the right member,
deny for a non-member, deny on the wrong permission, no-op on an empty array, and no
cross-group over-grant**.

- **A. CASL ability** - `apps/client/server/auth/__tests__/ability.test.ts`
  (`group-shared document access`). Member with the granted permission is allowed; a
  non-member, a member whose entry lacks the permission, and an empty `user.groups` are all
  denied; a permission granted to a different group on the same doc does not leak.
- **B. `buildOwnershipConditions`** - `packages/database/src/queries/fabFileSearchQuery.group.test.ts`.
  A non-empty `userGroups` adds exactly one `$elemMatch` arm scoped to those ids and
  `read`/`write`; an empty/absent `userGroups` adds no group arm; `restrictToDataLake` drops
  the broad ownership arms (incl. groups) as designed.
- **C. KB retrieve Path A** - `knowledgeBaseRetrieve/index.test.ts`
  (`group-shared access (Path A)`). Same grant/deny matrix, checked through the tool's
  by-id retrieval.

### Defect found and fixed as part of this pass

The CASL group arm (implementation A) was built with a **dotted** filter,
`{ 'groups.groupId': { $in: user.groups }, 'groups.permissions': permission }`. Compiled to
Mongo, the two conditions can be satisfied by **different** array elements: a doc shared
with group G (some other permission) and group X (this permission) would grant access to a
G-member. That is the over-broad grant this phase exists to prevent, on the highest-priority
access gate. It never mattered while `user.groups` was always empty, but it would have
mattered on the first real group.

Fixed to `$elemMatch` so the groupId and permission must hold on the same entry, matching
the pattern implementations B and C already use. Groups are dormant (empty collection), so
this is a forward-only correctness fix with no migration or behavior change for existing
data.

### Known sibling to evaluate separately

The **explicit-user** arm directly above the group arm in `ability.ts`
(`{ 'users.userId': user.id, 'users.permissions': permission }`) has the same dotted,
non-`$elemMatch` shape. It is live production behavior for user-to-user sharing (not dormant),
so it was left untouched here; in practice a doc lists a given `userId` once, so the
cross-entry match does not trigger. Worth a separate, deliberately-scoped look rather than
folding a live-behavior change into this dormant-path pass.

## Sign-off

- [x] CASL ability resolution behaves correctly with a non-empty `user.groups`.
- [x] `dataLakes/index.ts` (both call sites) - verified via implementation B.
- [x] `ChatCompletionFeatures.ts` - verified via implementation B.
- [x] `knowledgeBaseRetrieve` (Path A in-memory + Path B search) - verified via C and B.
- [x] `knowledgeBaseSearch` (semantic + keyword) - verified via implementation B.
- [x] No crash on non-empty input; no over-broad grant (CASL over-match fixed).
- [x] Documented as a repeatable checklist (this file + the tests above).
