# PR #1762 review-fix report

Branch: `fix/datalake-accesscontext-org-set`
Commit: `e27b8deb` `fix(data-lake): harden membership resolution per review`
(pushed as part of merge commit `6b6164c2` after `git pull --no-rebase` picked up the auto-changeset bot's `8a540eeb`)

Review source: `/private/tmp/claude-501/-Users-victor-coding-victor-bike4mind/70201994-47ca-4895-a4c4-d017ce3eb104/scratchpad/cleo-review-1762.md`

## N1 - reworded the fail-closed comments

- `b4m-core/services/src/dataLakeService/getDynamicDataLakeTags.ts:138-148` (was ~120-122)
- `b4m-core/services/src/dataLakeService/getDataLakePrompts.ts:110-121` (was ~104-106)

Both now say explicitly: membership resolution sits outside *this resolver's* degrade path, so a
transient failure propagates here rather than folding into "member of nothing" - but that
guarantee is local to the function. Top-level chat callers
(`ChatCompletionProcess.getAccessibleDataLakeAccess`, `b4m-core/services/src/llm/ChatCompletionProcess.ts:891-908`;
`ChatCompletionFeatures.ts`) may still catch the throw and degrade to an empty scope, which is
ALSO fail-closed (denies, never grants). The placement buys observability into where a failure
originated, not a stronger deny guarantee than returning `[]` outright would have given.

## N3 - runtime guard on the newly-required projected reader

- `getDynamicDataLakeTags.ts:133-137` - `if (typeof context.db.organizations?.findMembershipOrgIds !== 'function') throw new Error(...)`, placed inside the `if (context.db.dataLakes)` branch (see N4).
- `getDataLakePrompts.ts:100-105` - same guard, placed right after the existing `if (!repo) return []` / before the membership call.
- `b4m-core/services/src/dataLakeService/assertLakeAccess.ts:67` (`canAccessLake`) - `(ctx.organizationIds ?? []).includes(lakeOrgId)`, with a one-line comment that this is a runtime belt against a malformed ctx, not a type widening.
- `assertLakeAccess.ts:118` (`resolveFallbackLake`) - same `?? []` treatment.
- `packages/database/src/models/ai/DataLakeModel.ts:297-301` (`findAccessible`'s org constraint) - introduced `const memberOrgIds = ctx.organizationIds ?? [];` with the same comment, and rewired the constraint to use it.

Declared types (`organizationIds: string[]`) stayed required per the review's explicit ask - only the runtime reads got defensive.

Added two direct tests in `getDynamicDataLakeTags.test.ts` (see N7 below) that pin the new guard's error message.

## N4 - stopped resolving membership when `db.dataLakes` is absent

`getDynamicDataLakeTags.ts:113-160`: moved the guard + `organizationIds` resolution from before
`if (context.db.dataLakes)` to inside it (right before the existing try/catch around
`findActiveByUserTagsAndEntitlements`). A static-registry-only caller (no `dataLakes` repo wired)
now never calls `findMembershipOrgIds` and can't be made to throw on a lookup whose result it
never uses - matching `getAccessibleDataLakePrompts`'s existing `if (!repo) return []` ordering.

No test needed updating for call order: the existing "falls back to static lakes...when the
dataLakes repo is absent" test (`getDynamicDataLakeTags.test.ts:62-69`) never set `user.id`, so
`findMembershipOrgIds` was never invoked either before or after the reorder.

## N5 + N7 - four new tests

1. **`packages/database/src/models/ai/DataLakeModel.test.ts`** - new `describe('DataLakeRepository.findBySlug', ...)` block (inserted before the existing "fileTagPrefix is unique per creator" describe). Seeds two lakes with the same slug in `org-a`/`org-b`, calls `findBySlug('shared-slug', ['org-b', 'org-a'])`, asserts the resolved lake's `organizationId` is `'org-a'` (lexicographically lowest, per the `.sort({ organizationId: 1 })` in `DataLakeModel.ts:154`).

2. **`packages/database/src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts`** - new test `'excludes a soft-deleted org even though the user is still a member'`. Creates an org with a `users[]` ACL row, soft-deletes it via `Organization.collection.updateOne({ _id }, { $set: { deletedAt: new Date() } })` (mirrors the raw-driver mechanism `softDeletePlugin` itself uses, per `b4m-core/db-core/src/utils/mongo.ts:412-431`), asserts `findMembershipOrgIds` returns `[]`.

3. **`b4m-core/services/src/dataLakeService/getDynamicDataLakeTags.test.ts`** - two new tests:
   - `'propagates a membership-lookup failure instead of degrading to member-of-nothing'` - `findMembershipOrgIds` rejects, asserts `getDynamicDataLakeAccess(...)` rejects too (pins the N1 claim).
   - `'throws a legible error when db.organizations.findMembershipOrgIds is not wired'` - `organizations: {}` (no method), asserts a rejection matching `/findMembershipOrgIds/` (pins the N3 guard).

4. **`packages/scripts/migrate/migrations/20260813000001_ensure-organization-member-index.integration.test.ts`** (new file) - mirrors `20260813000000_fix-project-live-unique-name-index.integration.test.ts`'s shape: real `createMongoServer()`, drops `users.userId_1` up front (after explicitly `createCollection`-ing first, since a truly fresh mongod throws `NamespaceNotFound` on `listIndexes`/`dropIndex` against a collection that was never created - `deleteMany` alone doesn't create it, unlike the Project sibling where autoIndex apparently had already created the collection before the test ran). Two tests: index is absent before `up()`/present after, and `up()` is idempotent on re-run.

## N10 - investigated, could not durably revert; documented instead

`git diff origin/main -- packages/scripts/migrate/migrations/20260813000000_fix-project-live-unique-name-index.integration.test.ts`
confirmed the diff is formatting-only (a `.rejects.toMatchObject(...)` call reflowed).

However: running this repo's own `prettier --write` (with `.prettierrc.cjs`'s `printWidth: 120`)
directly on origin/main's checked-in version reproduces the exact reflow already in `HEAD` -
origin/main's line is 121 characters, one over the configured width, so prettier deterministically
rewrites it into the form the review calls "unrelated." I attempted the revert (`git checkout
origin/main -- <file>`) and committed it, but the repo's own pre-commit hook (`lint-staged` running
`prettier --write` on staged files) silently reformatted it straight back before the commit
completed - confirmed by checking the commit's diffstat (the file wasn't listed as changed) and by
reproducing the same revert+prettier sequence standalone.

Concretely: any commit that stages this file under the current hook will always reproduce the
"unrelated" diff, since origin/main's own stored version doesn't conform to the repo's active
prettier config. A durable revert is only possible by skipping hooks (`--no-verify`, forbidden here
per CLAUDE.md without explicit user instruction) or editing `.prettierrc.cjs`/lint-staged config
(out of scope for this task). I left the file untouched (reset to `HEAD`, which was its state
before I started) rather than ship a bypassed hook or a change that reverts itself. Flagging this
for a human decision: either bump origin/main's own copy of this line under 120 chars in a
follow-up, or treat this as accepted lint debt.

## Verification

1. `PATH=... pnpm --filter @bike4mind/services exec vitest run src/dataLakeService/getDynamicDataLakeTags.test.ts src/dataLakeService/getDataLakePrompts.test.ts src/dataLakeService/dataLakeService.test.ts`
   -> **3 files, 251 tests, all passed** (ran twice, before and after the N10 cleanup; unaffected).
2. `PATH=... pnpm --filter @bike4mind/database exec vitest run src/models/ai/DataLakeModel.test.ts src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts`
   -> **2 files, 109 tests, all passed**.
3. `PATH=... pnpm --filter @bike4mind/scripts exec vitest run migrate/migrations/20260813000001_ensure-organization-member-index.integration.test.ts`
   -> **1 file, 2 tests, all passed** (after fixing the `NamespaceNotFound` issue with an explicit `createCollection` in `beforeEach`).
   Also re-ran the neighbor `20260813000000_fix-project-live-unique-name-index.integration.test.ts` + its unit test to confirm no regression from the N10 investigation: **2 files, 8 tests, all passed**.
4. Also ran, to be safe given the resolver reorder/guards:
   - `src/llm/ChatCompletionFeatures.test.ts`, `src/llm/tools/implementation/knowledgeBaseCount/index.test.ts`, `knowledgeBaseRetrieve/index.test.ts`, `knowledgeBaseSearch/index.test.ts` in `@bike4mind/services` -> **4 files, 210 tests, all passed**.
   - `apps/client/server/dataLakes/resolveRetrievalLakeScope.test.ts` -> **1 file, 16 tests, all passed**.
5. `PATH=... pnpm turbo:typecheck` -> **40/40 tasks successful**.
6. `PATH=... pnpm lint:check` -> clean, no output.
7. ASCII-on-added-lines check (via `perl -ne 'print if /^\+/ && /[^\x00-\x7F]/'` over the diff, since the shell sandbox rejected the originally-specified `grep -P`/here-string form as "too complex to verify it stays inside the worktree") -> **no matches**.

## Files changed

- `b4m-core/services/src/dataLakeService/getDynamicDataLakeTags.ts` - N1 comment reword, N3 guard, N4 reorder.
- `b4m-core/services/src/dataLakeService/getDataLakePrompts.ts` - N1 comment reword, N3 guard.
- `b4m-core/services/src/dataLakeService/assertLakeAccess.ts` - N3 `?? []` defensive reads (`canAccessLake`, `resolveFallbackLake`).
- `packages/database/src/models/ai/DataLakeModel.ts` - N3 `?? []` defensive read in `findAccessible`'s org constraint.
- `b4m-core/services/src/dataLakeService/getDynamicDataLakeTags.test.ts` - N7 propagation + missing-adapter tests.
- `packages/database/src/models/ai/DataLakeModel.test.ts` - N5 slug tie-break test.
- `packages/database/src/models/infra/admin/OrganizationModel.membershipOrgIds.test.ts` - N7 soft-deleted-org test.
- `packages/scripts/migrate/migrations/20260813000001_ensure-organization-member-index.integration.test.ts` - new, N7 migration integration test.
- N10: no file changed (investigated and documented above).

## Changeset

`.changeset/pr-1762.md` regenerated by the bot after the PR retitle (picked up via `git pull --no-rebase`, commit `8a540eeb`):

```
"@bike4mind/common": major
"@bike4mind/services": major

authorize lakes by org membership set, not the selected-org pointer
```

Confirms the blocking item (patch -> major bump) is resolved.
