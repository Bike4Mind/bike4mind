# Partner rewards grant endpoint (BedrockNews Headword credits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A confined API key lets BedrockNews credit a Bike4Mind user for a solved Headword rung, once per user per puzzle rung, at amounts set in admin settings.

**Architecture:** One new confined scope, one service module modelled on the referral first-answer reward (ledger row through `creditService.addCreditsWithLedgerRow`, a stable `transactionId` for idempotency), and one Pages-API route gated by that scope. Amounts, the hard-mode multiplier, the first-solve bonus, the per-user daily cap and a global daily budget are admin settings so support can retune or switch the reward off without a deploy.

**Tech Stack:** Next.js Pages API with `baseApi`, zod, Mongoose models from `@bike4mind/database`, `@bike4mind/services` credit service, Vitest (node environment under `apps/client/server` and `apps/client/pages`).

**Spec:** `/Users/victor/coding.victor/bedrocknews/.claude/worktrees/pr450-headword/docs/superpowers/specs/2026-11-02-headword-progress-and-b4m-credits-design.md` (section B4). The BedrockNews caller is specified in that repo's plan `docs/superpowers/plans/2026-11-02-headword-progress-and-b4m-credits.md`.

## Global Constraints

- Contract: `POST /api/partners/rewards/grant` (BedrockNews reaches it as `{B4mBaseUrl}/partners/rewards/grant`, its base URL already ends in `/api`), auth by API key holding `rewards:grant`, body `{ userId: string, puzzleDate: "YYYY-MM-DD", tier: 5|6|7, hard: boolean }`, 200 `{ granted: boolean, credits: number, balance: number, firstSolveCredits: number }`. On a replay `granted: false` and `credits` is the stored ledger row's amount (the caller may have lost its own record of the payment and stamps what it is told); `firstSolveCredits: 0`. 400 on a bad body, 404 when the user does not exist, 403 when the user may not be paid (unverified, banned, deleted, synthetic) or when a cap is hit; the 403 body carries `{ error, code: "USER_NOT_ELIGIBLE" | "DAILY_CAP" | "BUDGET_EXHAUSTED" }`.
- Ledger row: `type: 'generic_add'`, `ownerType: CreditHolderType.User`, `reason: 'bedrocknews_puzzle_reward'`, `transactionId: \`bedrocknews-puzzle:${userId}:${puzzleDate}:${tier}\``, `metadata: { product: 'bedrocknews', game: 'headword', puzzleDate, tier, hard }`, `description: 'Headword: solved the N-letter word on YYYY-MM-DD'`.
- First-solve bonus row: same `type/ownerType`, `reason: 'bedrocknews_first_solve'`, `transactionId: \`bedrocknews-first-solve:${userId}\``.
- Settings (all `makeNumberSetting`, `int: true` except the multiplier, `min: 0`, `category: 'Referrals'`, defaults as listed): `BedrockNewsPuzzleCredits5` 40, `BedrockNewsPuzzleCredits6` 60, `BedrockNewsPuzzleCredits7` 100, `BedrockNewsPuzzleHardMultiplier` 1.5, `BedrockNewsFirstSolveCredits` 500, `BedrockNewsPuzzleDailyCap` 300 (per user, per `puzzleDate`, excluding the first-solve bonus), `BedrockNewsRewardsDailyBudget` 200000 (global, rolling 24 h, all reasons above). A per-tier amount of 0 means that rung pays nothing but still answers `granted: true, credits: 0`.
- `puzzleDate` must be within the last 30 days (UTC) and not after today; otherwise 400.
- The scope is confined and admin-provisioned: added to `CONFINED_API_KEY_SCOPES`, to `UNDOCUMENTED_API_KEY_SCOPES` (automatic via the confined filter), and to `ADMIN_ONLY_API_KEY_SCOPES` in `apps/client/app/constants/apiKeyScopes.ts`.
- Comments: why-only, short. Commit style per repo (`commitlint`), no ticket refs in code.

## Review Focus

1. Two concurrent grants for the same user/date/tier must pay once. Pinned in Task 2 (duplicate `transactionId` returns net-zero → `granted: false`).
2. A `b4m-second`-style replay from another BedrockNews account must not consume the daily cap twice. Pinned in Task 2 (cap sums ledger rows, and the replay adds none).
3. The first-solve bonus must be paid once even if the first rung grant and a retry race. Pinned in Task 2 (bonus keyed by user only).
4. A key with another confined scope (e.g. `overwatch-ingest:write`) must get 403, not a grant. Pinned in Task 3.
5. A user document missing `emailVerified` must be treated as not eligible. Pinned in Task 2.

---

### Task 1: Scope and settings

**Files:**
- Modify: `b4m-core/common/src/types/entities/UserApiKeyTypes.ts` (enum near line 45, `CONFINED_API_KEY_SCOPES` at 228)
- Modify: `apps/client/app/constants/apiKeyScopes.ts` (`ADMIN_ONLY_API_KEY_SCOPES`, ~line 584)
- Modify: `b4m-core/common/src/schemas/settings.ts` (key list near line 359, definitions near line 3307)
- Test: the existing scope tests next to `UserApiKeyTypes.ts` (extend whichever asserts the confined/undocumented lists) and `apps/client/app/constants/apiKeyScopes.test.ts` if present

**Interfaces:**
- `ApiKeyScope.REWARDS_GRANT = 'rewards:grant'`.
- UI entry: `{ value: ApiKeyScope.REWARDS_GRANT, label: 'Partners: Rewards', description: 'Server-to-server credit grants for partner games (BedrockNews Headword)', endpoints: ['POST /api/partners/rewards/grant'] }`.
- Setting keys as in Global Constraints; description for the per-tier ones: `'Credits a BedrockNews Headword player earns for solving the N-letter word. 0 pays nothing for that rung.'`

- [ ] **Step 1: Failing test**: `expect(CONFINED_API_KEY_SCOPES).toContain(ApiKeyScope.REWARDS_GRANT)` and `expect(UNDOCUMENTED_API_KEY_SCOPES).toContain(ApiKeyScope.REWARDS_GRANT)`; settings test (if the file has one per setting) asserts the seven defaults.
- [ ] **Step 2: Run** `pnpm --filter @bike4mind/common test -- UserApiKeyTypes` — FAIL.
- [ ] **Step 3: Implement** the enum member, the lists, the UI entry, the settings.
- [ ] **Step 4: Run** the common and client-constants tests and `pnpm turbo:typecheck:fast` — PASS.
- [ ] **Step 5: Commit** `feat(api-keys): rewards:grant confined scope and BedrockNews reward settings`.

---

### Task 2: Reward service

**Files:**
- Create: `apps/client/server/partners/bedrocknewsPuzzleReward.ts`
- Test: `apps/client/server/partners/bedrocknewsPuzzleReward.test.ts` (mock layout copied from `apps/client/server/referrals/firstAnswerReward.test.ts`)

**Interfaces:**
```ts
export const BEDROCKNEWS_PUZZLE_REASON = 'bedrocknews_puzzle_reward';
export const BEDROCKNEWS_FIRST_SOLVE_REASON = 'bedrocknews_first_solve';
export type PuzzleTier = 5 | 6 | 7;
export interface GrantPuzzleRewardInput { userId: string; puzzleDate: string; tier: PuzzleTier; hard: boolean }
export type GrantPuzzleRewardResult =
  | { ok: true; granted: boolean; credits: number; balance: number; firstSolveCredits: number }
  | { ok: false; status: 404 | 403; code: 'USER_NOT_FOUND' | 'USER_NOT_ELIGIBLE' | 'DAILY_CAP' | 'BUDGET_EXHAUSTED' };
export async function grantPuzzleReward(input: GrantPuzzleRewardInput): Promise<GrantPuzzleRewardResult>;
```
Algorithm (the parts the signature does not fix):
1. `User.findById(userId).select('emailVerified isSynthetic deletedAt isBanned disputePending moderation.status currentCredits').lean()`; null → 404; `!emailVerified || isSynthetic || deletedAt || accountBlockReasons(user).length || moderation?.status === 'suspend_pending'` → 403 `USER_NOT_ELIGIBLE`.
2. Settings via `getSettingsMap(..., { names: [the seven], skipCache: true })`; `amount = Math.round(tierCredits * (hard ? multiplier : 1))`.
3. Daily cap: `CreditTransaction.aggregate` sum of `credits` where `ownerId, reason: BEDROCKNEWS_PUZZLE_REASON, 'metadata.puzzleDate': puzzleDate`; if `sum + amount > cap` → 403 `DAILY_CAP`. (The replay case never reaches here with a new row, see step 5.)
4. Budget: sum of `credits` over both reasons with `createdAt >= now - 24h`; `sum + amount > budget` → 403 `BUDGET_EXHAUSTED`.
5. `addCreditsWithLedgerRow` with the puzzle row; `creditTransactionId` null/undefined (duplicate, net zero) → `granted: false`, `credits` = the existing row's `credits` (read it by `transactionId`), no bonus attempt.
6. On a fresh grant and `BedrockNewsFirstSolveCredits > 0`: `addCreditsWithLedgerRow` with the bonus row; a duplicate → `firstSolveCredits: 0`.
7. `balance` = re-read `currentCredits` after the writes.
Order of checks 3 and 4 before 5 is deliberate: a replay must not be refused by a cap it already consumed, so do the duplicate check first: `CreditTransaction.findOne({ transactionId }).select('credits')` → if it exists return `granted: false, credits: <its credits>` before the caps.

- [ ] **Step 1: Failing tests** (`it.each` where natural):
  1. pays 40 for tier 5, 60 for 6, 100 for 7; hard → 60/90/150; metadata and transactionId exact;
  2. replay (an existing row with credits 40) → `granted: false, credits: 40`, `addCredits` not called;
  3. first fresh grant also writes the first-solve row with 500; second day's grant does not (bonus duplicate → 0);
  4. cap: existing 300 on the date → `DAILY_CAP`;
  5. budget exhausted → `BUDGET_EXHAUSTED`;
  6. ineligible cases: missing user → 404; `emailVerified` undefined, synthetic, deleted, banned, suspend_pending → 403;
  7. tier amount 0 → `granted: true, credits: 0`, no ledger write.
- [ ] **Step 2: Run** `pnpm --filter @bike4mind/client exec vitest run server/partners` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(partners): grant Headword puzzle credits with a stable ledger key`.

---

### Task 3: Route

**Files:**
- Create: `apps/client/pages/api/partners/rewards/grant.ts`
- Test: `apps/client/pages/api/partners/__tests__/rewards-grant.integration.test.ts` (driving the real `baseApi` chain the way `pages/api/__tests__/identify.test.ts` does)
- Modify: `docs/api-route-inventory.md` via `pnpm --filter @bike4mind/scripts api-routes:inventory`

**Interfaces:**
- `baseApi({ requiredScopes: [ApiKeyScope.REWARDS_GRANT] }).post(asyncHandler(...))`, `export const config = { api: { externalResolver: true } }`.
- Body schema: `z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/), puzzleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tier: z.union([z.literal(5), z.literal(6), z.literal(7)]), hard: z.boolean() })`; date window check in the handler → 400 `{ error: 'puzzleDate out of range' }`.
- Response: `ok: true` → 200 with the four fields; `ok: false` → `status` with `{ error, code }`.
- `recordAdminActionFromRequest` is not used (not an admin action); log one line per grant with `Logger.info('[partners] headword reward', { userId, puzzleDate, tier, granted, credits })`.

- [ ] **Step 1: Failing integration tests**: key with the scope → 200 and the service called with the parsed body; key with `overwatch-ingest:write` only → 403 before the service; session user without a key → 403 (route is key-only: assert `baseApi` option that disables session auth if one exists, else assert the scope gate); bad tier → 400; date 31 days ago → 400.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the test, `pnpm turbo:typecheck:fast`, `pnpm lint:check`, regenerate the inventory and check the new row reads `| \`/api/partners/rewards/grant\` | POST | key | \`rewards:grant\` | ... |`.
- [ ] **Step 5: Commit** `feat(partners): POST /api/partners/rewards/grant for BedrockNews Headword`.

---

### Task 4: Key, deploy and hand-off (ops, with Victor)

- [ ] Create the service user `bedrocknews-rewards@bike4mind.com` on staging and prod (or reuse the owner of the Overwatch ingest key if that is a service account).
- [ ] Mint one key per environment with the single scope `rewards:grant` from the admin key UI (`ADMIN_ONLY_API_KEY_SCOPES`).
- [ ] Set the seven settings in Admin › Referrals (defaults already match the spec); keep `BedrockNewsFirstSolveCredits` at 500.
- [ ] Hand the staging key to BedrockNews: `sst secret set B4mRewardsApiKey <key> --stage vibeswire-dev` (run through `scripts/sst.sh` in that repo).
- [ ] Smoke: `curl -X POST https://<staging>/api/partners/rewards/grant -H 'X-API-Key: …' -d '{"userId":"<test user>","puzzleDate":"<today>","tier":5,"hard":false}'` → `granted: true, credits: 40`; repeat → `granted: false`.
