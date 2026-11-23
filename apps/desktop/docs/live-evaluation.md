# Guarded Desktop live evaluation

This is a blocked implementation path, not paid evaluation evidence. No provider
calls were made during implementation. The existing offline harness remains intact.

The Electron main process recognizes `--controlled-cost-evaluation-live`. Without
that exact argument it does nothing. With it, the current build writes
`controlled-evaluation/blocked.json` under Electron userData, before consulting
auth or making network calls. There is deliberately no environment variable,
JSON proof, CLI flag or local setting that clears either execution blocker:

- The issuer must amend the existing dedicated-key authorization to permit this
  signed-in backend route. The coordinator owns that request.
- The backend must expose a verifiable maximum billed-input/output/retry contract
  for this route. The existing completion contract exposes an output request
  ceiling, not proof that hidden tokens or server/provider retries share it.

Do not remove these blockers just to run the fixture. Implementation is not
authorization, and an application budget is not a global provider-key cap.

## Implemented path

After those gates are implemented and reviewed, the entry point uses
`AuthService.getSessionBoundApiClient()`, the account's real ModelCatalog and real
ChatService. It neither reads auth stores nor accepts provider keys. Only the
exact available OpenAI-backed `gpt-6.1-sol` record is admitted; there is no Opus
fallback. The catalog price map is recorded. Effective arms are selected before
fixture creation: the unsupported zero deferred start set is reported as
`duplicate-effective-arm-not-run` for this OpenAI model, with no second session,
request or reservation. Only the reference runs; this is not a matched comparison
or evidence for deferred-loading savings. Acceptance requires a
successful file_read and the exact single-character answer, not just a success
HTTP response. No other tools, workers or model upgrades are admitted.

An AsyncLocalStorage scope gates hosted `streamCompletion` requests, including
auxiliary requests, retries and any continuations in that evaluator scope, without
gating normal user chat. A SQLite WAL/FULL transaction reserves before POST, with
one shared fixed ledger across arms and restarts, at most $150, 20 requests,
131072 input tokens, 2048 output tokens, four rounds per fixture and zero workers.
Input JSON has a stricter byte envelope; that envelope is not a verified provider
tokenizer bound, which is one reason execution remains blocked. Reservations use
the full input ceiling at the highest published rate (including 1h cache writes)
plus the full output ceiling, never a cache-hit assumption. Concurrent admissions
are refused. The transaction also refuses any unresolved previous attempt.

Reservations are never refunded by client usage. Every failed, disconnected or
unreconciled attempt retains its full hold on disk. Request-scoped SSE usage is
folded by replacement, never by adding cumulative turn events. Matching settlement
records platform USD and credits separately; it does not establish provider cost.
Even a usage-reported settled request blocks further admission until provider
billing is reconciled. Reports omit prompts, outputs, paths, session/request IDs,
tool arguments, exception text and credentials; unknown costs remain null.

## Remaining scope

This is intentionally incomplete while authorization and billing bounds are
pending: provider-priced reconciliation (including reasoning/cache semantics and
hidden retry bounds), safe release of reservations, exact tokenizer validation,
and a verified authorized execution gate. The matched fixture path has not run
against a paid backend. Full cache-TTL waits, warm/restart/compaction acceptance,
worker/wake cases and the larger quality/latency matrix are not implemented here.
Worker coverage currently means admission is denied, not measured worker spend.
There is no claim of savings or completion of the live-cost issue.

## Backend follow-on edit points and required contract

These are existing source locations, not implemented guarantees. Keep the issuer
amendment and backend-bound blockers closed until the following contract is
implemented, tested and reviewed. Do not substitute a credit budget for provider USD.

| Layer | Existing edit points | Required addition for evaluation traffic |
| --- | --- | --- |
| Public contract | `b4m-core/common/src/api-contract/contracts/completions.contract.ts` (`createCompletionContract`); `b4m-core/common/src/schemas/cliCompletions.ts` (`CompletionRequestSchema`, settled event schema) | A versioned admission receipt identifying the authorized evaluation, exact resolved model/backend, immutable pricing revision, accepted input/output/attempt bounds and maximum provider USD. Unsupported or unpriced requests must fail before provider dispatch. Derive handler/schema/docs/client from this contract. |
| Run identity and reads | `b4m-core/common/src/api-contract/contracts/completionRuns.contract.ts`; `apps/client/server/completionRuns/callerCompletionRun.ts` (`findCallerCompletionRun`); `apps/client/pages/api/v1/completion-runs/[runId]/usage.ts` | Ownership-bound durable evaluation identity shared by every root/auxiliary/worker request; restart-safe request-level reconciliation lookup, not just aggregate charged-credit totals. Preserve current account/billing-owner checks. |
| Authenticated stream | `apps/client/server/chatCompletion/external/sseRoute.ts` (request ID, `verifyRunOwnership`, `executeCompletion`, `onSettled`, `buildSettledEvent`) | Require the evaluation admission on every request and carry its receipt to terminal settlement/error and recovery lookup. A missing run must never silently fall back to an unattributed paid request. A disconnect is not proof of no charge. |
| Admission and settlement | `b4m-core/services/src/cliCompletions.ts` (`executeCompletion`, output sizing around 876, credit reserve around 1027-1190, `settledUsdCost` around 1262, settlement around 1497-1785) | Compute a conservative provider-USD maximum using final transformed messages/tools and effective output/reasoning bounds before dispatch. Atomically reserve against the evaluation-wide remaining USD. All internal attempts/rounds must consume that same admission or reserve more before they start. Persist ambiguous failures, never release them merely because client transport or credit settlement ended. |
| Durable holds | `apps/client/server/billing/completionCreditHolds.ts` (`reserve`, `topUpRunClaim`, `refund`, `settle`); `packages/database/src/models/billing/CompletionRunModel.ts` (`claimBudget`, `releaseClaim`) | Reuse lifecycle boundaries, but provide a distinct provider-USD invariant and durable per-attempt holds. Existing claims are estimated credits; current refund/expiry semantics cannot establish provider cancellation. Require authoritative terminal evidence before releasing a provider hold. |
| Provider transport | `b4m-core/llm-adapters/src/openaiBackend.ts` (`floorOutputBudget`, OpenAI parameter construction, `withRetry` call); `b4m-core/llm-adapters/src/transportRetry.ts` (`retryTransportErrors`) | Account for SDK and adapter retries, hidden attempts, minimum-output flooring, cached and reasoning tokens, and any route/model substitution. Either disable retries for this mode or admit each attempt under the shared bound. Refuse any transformation whose maximum bill cannot be established. Keep exact model pinning; no automatic Opus fallback. |
| Price and usage provenance | `b4m-core/common/src/models.ts` (`resolveAppliedRates`, `getTextModelCost`, `getTurnsCost`); `b4m-core/services/src/cliCompletions.ts` (`finalTurnUsage`, price provenance, `chargedUsdCost`) | Publish request/attempt-scoped final usage and resolved provider rates separately from platform charged-model USD and credits. Include tier basis, input/cache-read/cache-write 5m/1h, billed output/reasoning semantics, actual resolved model/backend and pricing revision. Never label platform `usdCost` as actual provider invoice cost. |

The reconciliation receipt must distinguish pending, complete, rejected-before-
dispatch and unknown-charge outcomes; carry monotonic revision/finality and
stable attempt identities so replacement/upsert cannot double-count replayed
events. An absent receipt, missing usage class, mismatched identity, ambiguous
retry or unknown pricing keeps the whole reservation and blocks more admission.
Only a complete authoritative receipt can replace a hold with provider-priced
usage; platform credits/USD are separate fields. Tests must cover concurrent
admission, disconnect after dispatch, server restart, duplicate settlement,
unknown retry charges, tokenizer/serialization expansion and pricing changes.

Existing `budgetCredits` explicitly uses estimated input and can overrun its
claim by the estimation miss; a deployment that does not charge credits counts
nothing against that budget. It is useful infrastructure, not the missing
provider-USD ceiling. The current Desktop ledger therefore still blocks after
the first unreconciled request, even if SSE reports a platform settlement.

## Regression attribution for this partial delivery

The chat/shared run was repeated on the implementation, then all 15 failing
files were run on the exact recorded fresh base in the same worktree with the
same installed dependencies and `VITEST_MAX_WORKERS=25%`. No Git configuration
was changed to make either result pass. The base was
[01a2b43e41](https://github.com/Bike4Mind/bike4mind/commit/01a2b43e41ce1f606522faea953e8f6a8866c55e).
The pre-revision implementation was
[ca310bdc92](https://github.com/Bike4Mind/bike4mind/commit/ca310bdc92344599ef17b7c8a1e6442ea0563df1).

All paths below are relative to `apps/desktop/src/main/chat/`. Counts are failed
assertions, not skipped tests. The sorted full failed-test names match exactly
between implementation and base in all 13 assertion-failing files.

| File | Implementation | Base |
| --- | ---: | ---: |
| `ChatService.approvalMode.test.ts` | 38 | 38 |
| `ChatService.approvalRecord.test.ts` | 2 | 2 |
| `ChatService.permissions.test.ts` | 6 | 6 |
| `ChatService.project.test.ts` | 49 | 49 |
| `ChatService.sessionScripts.test.ts` | 1 | 1 |
| `ChatService.spawnPlacement.test.ts` | 34 | 34 |
| `permissions/rules.test.ts` | 3 | 3 |
| `project/workspace.test.ts` | 51 | 51 |
| `tools/shellTools.gitTable.test.ts` | 62 | 62 |
| `tools/shellTools.protected.test.ts` | 11 | 11 |
| `tools/shellTools.review.test.ts` | 17 | 17 |
| `tools/shellTools.signatureApproval.test.ts` | 4 | 4 |
| `tools/shellTools.test.ts` | 2 | 2 |
| `tools/shellTools.gitPrograms.test.ts` | setup failure | same setup failure |
| `tools/shellTools.regressions.test.ts` | setup failure | same setup failure |

Both setup failures were also reproduced individually on both revisions: Git
configuration of the temporary bare fixtures fails with `not in a git directory`
at `gitPrograms.test.ts:627` and `regressions.test.ts:341`. Other representative
failures include the bare-repository safety restriction, missing signing-config
text in approval prompts and the session-script timeout. They are baseline-
reproduced, not declared unrelated from their messages. Total: 280 failed
assertions and two failed setup suites on each revision. No implementation-only
failed assertion was observed in this comparison; the broader suite remains red.

Reproduction: `pnpm --filter @bike4mind/desktop exec vitest run src/main/chat/
src/shared/ --reporter=json --outputFile=<scratch-report>`; run the 15 files above
on the base with the same command and compare each file's failed `fullName` set.
The JSON reports are local scratch evidence, not committed logs with machine paths.
