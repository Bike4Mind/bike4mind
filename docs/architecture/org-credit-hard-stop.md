# Organization credit balance: hard stop verification (#1238)

**Question:** Is an organization's `currentCredits` balance a hard stop (a real floor that
rejects spend at zero), or a soft limit that can be pushed negative?

**Verdict: it is a hard stop per single request.** An org's balance floors at zero on every metered
spend path and is never driven negative by one request. The residual soft edges are both
concurrency-shaped - concurrent settlement of a chat stream, and concurrent standalone image/video
deducts (both below) - and the whole floor is gated on the `enforceCredits` admin setting by design
(except the embed path, which is settings-free).

This matters because org-wide balance is the only bound on *aggregate* spend. The per-member cap
(`maxCreditsPerMember`) limits any single member but scales with headcount; once orgs self-serve
which members reach the expensive execution paths (#1237), the balance is what caps total exposure.

## Where the floor is enforced (evidence)

Three independent layers, all keyed on the org balance when the request is org-billed:

1. **Atomic pre-flight reservation** (primary, race-safe). Bare `$inc(-required)` then reject +
   roll back if the returned `currentCredits < 0`. Because the check reads the value *returned by*
   the atomic decrement, it closes the check-then-act race.
   - chat: `b4m-core/services/src/llm/ChatCompletionProcess.ts` (reservation ~2445-2457, holder is
     the org when org-billed ~2422-2426)
   - CLI: `b4m-core/services/src/cliCompletions.ts` (~280-293)
   - sound-effects: `apps/client/pages/api/ai/sound-effects.ts` (~114-123)

2. **Settlement true-up clamp** (never-negative reconciliation). Pre-reservation runs on a local
   *estimate*; provider-basis settlement can exceed it. `computeSettlementDelta`
   (`ChatCompletionProcess.ts:539-550`) clamps the shortfall debit to the available balance and
   reports the remainder as `writtenOffCredits` (uncollected revenue surfaced on the usage event
   for margin reporting). The balance floors at zero; the platform eats the overrun rather than
   pushing the customer negative. A `[BILLING_SHORTFALL_CLAMP]` warn fires when it triggers
   (`ChatCompletionProcess.ts:3758-3767`).

3. **Embed pre-gate** (settings-free). `assertOwnerHasCredits`
   (`b4m-core/services/src/billing/assertOwnerHasCredits.ts`) refuses a broke owner *regardless* of
   `enforceCredits`, so an anonymous embed end-user can never spend an org into the negative even on
   a credits-off stage. Used by `apps/client/server/chatCompletion/external/embedRoute.ts:384`.

## Consistency across spend paths

- The atomic reservation is enforced identically in the three text/audio paths above, but it is
  **inline-triplicated** rather than a shared helper. Currently consistent; a shared
  `reserveOrReject` seam would prevent drift (suggested follow-up, deliberately not done here to
  avoid refactoring hot billing paths under a "confirm" task).
- The image/video/tool paths do a **check-then-act** comparison against `organization.currentCredits`
  rather than an atomic reserve, so a concurrent-request window can momentarily let two requests both
  pass the check. How that window is bounded differs by path, and the distinction matters:
  - **In-stream tool calls** validate through the shared `validateUserCredits`
    (`b4m-core/services/src/llm/tools/base/utils.ts`) inside an already-reserved chat completion. The
    reserved balance is written back to `organization.currentCredits` so mid-stream validation sees
    the reduced figure (`ChatCompletionProcess.ts:2460-2461`), and the settlement clamp (layer 2)
    trues the whole stream up without going negative.
  - **Standalone image/video generation** is bounded by the check-then-act *only* - layer 2 does not
    reach it. `ImageGeneration.ts` has its own private `validateUserCredits` (`credits <
    requiredCredits`, ~line 450) and never touches `ChatCompletionProcess` or
    `computeSettlementDelta`; it deducts post-generation via `deductCreditsWithOrgSupport` (~line
    1278) with no `skipBalanceUpdate`, so it reaches the bare `$inc` in
    `subtractCredits.ts:242` -> `incrementCredits`
    (`packages/database/src/models/infra/admin/OrganizationModel.ts:186-192`), which has no floor
    guard. Two concurrent standalone image requests against a near-zero org balance can therefore
    both pass the check and both deduct, with nothing downstream to clamp or refund. This inherits
    the same concurrency softness recorded under "Concurrent settlement" below; the per-single-request
    verdict is unaffected. Making it exact needs the same fix: a conditional atomic decrement, or
    routing these paths through a shared `reserveOrReject`.

## Where it is (deliberately) soft

- **`enforceCredits` toggle.** Layers 1 and 2 only run when the `enforceCredits` admin setting is
  on. When off (self-host / credits-off deployments) nothing is reserved or floored - intentional.
  Layer 3 (embed) is the exception and is settings-free.
- **Concurrent settlement.** The settlement clamp is computed against a balance *snapshot* taken at
  reservation time (`computeSettlementDelta` docstring). Under simultaneous settlements the snapshot
  can be stale, so the never-negative guarantee is exact per single request and best-effort under
  concurrency. Making it exact would require a conditional atomic decrement (`$inc` guarded by
  `balance >= amount`) - out of scope for this confirmation; flag if concurrency-driven negatives
  are observed.
- **Concurrent standalone image/video generation.** Check-then-act with no atomic reserve and no
  settlement clamp downstream (see "Consistency across spend paths"). Pre-existing and unchanged;
  called out here so the clamp is not read as covering it.
- **Per-member cap** (`maxCreditsPerMember`) is a documented check-then-act TOCTOU (off-by-one under
  concurrency: `deductCreditsWithOrgSupport.ts:155`). That is the *per-member* axis, not the
  org-wide balance, and does not affect the balance floor.

## Regression coverage

- `computeSettlementDelta` example cases and a swept **hard-stop invariant** (`available + delta >= 0`
  for all inputs; shortfall conserved between collected and written-off) live in
  `b4m-core/services/src/llm/ChatCompletion.test.ts`, with a fractional-credit case alongside the
  integer sweep (real credits are token-derived floats).
  Scope: that is a unit test on one pure function. It pins the arithmetic of the clamp, **not** that
  any given spend path calls it - the standalone image/video path does not. The cross-path claims in
  this document rest on code reading, which is what a "confirm" task can establish; do not cite this
  test as broader proof.
- `assertOwnerHasCredits` (embed floor) is pinned in
  `b4m-core/services/src/billing/assertOwnerHasCredits.test.ts`.
