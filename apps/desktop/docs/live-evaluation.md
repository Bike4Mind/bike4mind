# Opt-in Desktop live evaluation

Implementation is not authorization or evidence of savings. No paid calls were
made while implementing this evaluator. Run it only with explicit authorization
for the signed-in account's evaluation budget.

## Run

Build Desktop, launch it normally, sign in to the intended server/account, and
quit it completely. The evaluator starts only after normal authentication restores.
A server administrator must independently allow the account and the exact model ID
in Admin > Settings > AI Configuration: add the user ID to **Controlled
Evaluation: Allowed User IDs** (`evaluationUserIds`) and, after verifying its
provider identity, the model ID to **Controlled Evaluation: Allowed Model IDs**
(`evaluationModelIds`). Both are comma-separated, empty by default, and both are
required. They are read on every evaluation request, so a change applies without a
redeploy, and clearing them switches evaluation off again. A client flag cannot
grant administrative permission.

From the repository root:

```sh
pnpm --filter @bike4mind/desktop build
node apps/desktop/scripts/controlled-cost-evaluation.cjs --live --accept-paid-requests
```

This launches the built Electron app with `--controlled-cost-evaluation-live`.
The normal signed-in AuthService, ModelCatalog, ChatService, completion transport,
and read-only local tools are used. No provider credentials or alternate provider
route are accepted. The exact available OpenAI-backed `gpt-6.1-sol` catalog record
and its pricing map are pinned on the first run. An absent/disabled model, changed
pricing on resume, missing evaluation contract, or administrative refusal stops
the run before further dispatch. There is no model fallback or automatic spend.

The server creates one evaluation-enabled completion run. Every request, including
compaction and auxiliary requests, carries that run and a unique evaluation
request identity. The same run is recovered after restart. The fixed shared limits
are $150 provider-priced USD, 2,000,000 input-plus-output tokens, and 200 requests;
each request has a 2,048 output ceiling and each turn at most 24 rounds. Server
admission remains authoritative and may reject a request sooner (for example,
its full-context conservative reservation may exceed remaining tokens).

The separate dry-run command remains free and uses scripted responses:

```sh
node apps/desktop/scripts/controlled-cost-evaluation.cjs --dry-run
```

## Independent controls

Supply a local JSON config using `--config=/absolute/path/config.json` after the
two live opt-in arguments. Unknown keys, credentials, and model overrides are refused.

```json
{
  "version": 1,
  "arms": ["reference", "deferred-zero", "ttl-only", "compaction-only"],
  "warm": true,
  "longLoop": true,
  "loopDepth": 8,
  "workers": false,
  "toolChange": true,
  "restart": false,
  "pauseMs": 0
}
```

- `reference` uses ordinary loading, 5m policy, no explicit compaction.
- `deferred-zero` uses the existing deferred loader with start-set threshold 0
  only when the exact model supports it. The OpenAI sweep skips it as an effective
  duplicate; it does not pretend this evaluates Anthropic deferred loading.
- `ttl-only` changes only TTL policy to 1h when the model advertises support;
  otherwise it is skipped, without creating another session or request.
- `compaction-only` explicitly invokes ChatService compaction and then checks
  that the task answer survives it. Its summarization attempts count in arm cost.
- `warm` repeats the evidence-based sum in the same stored session.
- `workers` launches one read-only child per arm through the normal ChatService
  spawn/watch lifecycle and waits for its automatic parent wake. Child reads,
  parent wake, and auxiliary requests share the same evaluation run. Requests are
  serialized before admission; a pending/unknown receipt still stops all dispatch.
- `longLoop` asks the model to follow a linked-file chain sequentially. Acceptance
  requires the exact sum and at least `loopDepth` successful file reads, not merely
  an HTTP success. Depth is independently bounded from 4 to 16.
- `toolChange` withdraws glob/search between turns and then replays the history
  through ChatService with file_read still callable. It does not change permissions.
- `pauseMs` waits actual wall-clock time (up to 3,660,000 ms) before resuming.
  Choose 310000 for just beyond 5m, or 3660000 for beyond 1h; run separately from
  compaction if measuring TTL alone. Flags do not establish cache hits.
- `restart` checkpoints at a process boundary and writes `restart-required`.
  Quit the whole Electron process and launch with the identical command/config.
  A new main-process identity is required before the post-restart turn can run.
  This is a real process boundary, not service recreation counted as a restart.

Each arm gets the same generated project/user instructions, ledger-sum task, and
linked-file task, isolated in its own project/session. The fixtures use synthetic
data and explicit exact-answer/tool-use checks. No code writes or shell commands
are authorized. Reading global user instructions is replaced by fixture-specific
required instructions; existing tool path protections and session approvals remain.

## Persistence, receipts, and recovery

State lives in `controlled-evaluation/` under Electron userData. Do not remove or
copy its database/checkpoint to reset spending. Normal completion-run ownership
checks bind the remote run to the signed-in account and billing owner.

- `budget-v2.sqlite`: durable local holds, server identity, authoritative receipt
  revisions, sanitized request measurements, platform settlement separately.
- `checkpoint.json`: private resumable fixture/session identifiers and stage state.
- `report.json`: the exportable sanitized report, atomically replaced after a run.
- `active.lock`: process exclusion. A dead process's lock is recovered; an active
  process's lock is never silently stolen.

Complete server receipts with provider usage/rates replace holds with actual
provider-priced usage; rejected-before-dispatch receipts settle at zero. Pending,
unknown, missing, conflicting, or incomplete receipts retain holds and prevent the
next request. SSE credits/USD never release a provider hold. Failed/disconnected
attempts remain in reports. Restart first fetches remote receipts and does not
automatically replay an interrupted paid turn. The interrupted stage is recorded
as a failed result; the server's durable request ID prevents duplicate dispatch.

An ambiguous run-creation response is held as `mint-pending`. On the next explicit
launch the identical POST uses the persisted rootSessionId: server idempotency
returns the same run and counters, never silently mints another budget. An explicit
`--recover-run=<known-run-UUID>` may also import an ownership-checked existing run;
it cannot replace a different acknowledged run or exceed the configured limits.

Only `report.json` is intended for export. It omits raw prompts, answers, paths,
session/request IDs, tool arguments, exceptions, credentials, and task contents.
It includes failed attempts, acceptance/rejection by arm and stage, exact catalog
pricing, receipt rate/provenance fields, provider-priced cost distinct from platform
USD/credits, and cost per accepted result (null when spend remains unresolved).
Per-request role-based source categories and lengths expose size changes without
exporting text or content-derived hashes. These byte measurements are not tokenizer
counts or causal cache attribution; stable-prefix and rewrite causes remain unknown.

## Explicit final Opus phase

To prepare a final comparison, set `finalModelId` in the config to the exact
available, priced direct-Anthropic Opus catalog ID before the first sweep. The
initial budget then includes both exact model IDs, but the sweep's local dispatch
gate permits only `gpt-6.1-sol`, including auxiliary requests. Merely listing Opus
does not authorize its dispatch. After the sweep completes with at least one
accepted fresh evidence-based result, a separate launch is
required with the same config and this additional explicit opt-in:

```sh
node apps/desktop/scripts/controlled-cost-evaluation.cjs --live --accept-paid-requests --final --config=/absolute/path/config.json
```

The final phase uses the same server run, ledger, USD/token/request limits, and
matched fixtures. It creates `checkpoint-final.json` and `report-final.json` and
enables effective deferred-loading and 1h arms only when that exact model supports
them. Both models must be administratively allowed. No automatic phase transition,
fallback, model alias substitution, or second spending budget is created.

## Real remaining constraints

Provider response identities must exactly match the catalog-dispatched ID;
provider aliases without a matching identity retain unknown holds. Tool-output
shrink or orchestration default changes are not inferred from this harness.

Provider-priced costs are catalog-rate calculations from authoritative provider
usage, not provider invoices. OpenAI receipts explicitly report zero cache-write
5m/1h counts; categories remain unknown when not supplied. Receipts include input
and output admission bounds separately and platform charges where available.
Prefix hashes alone cannot distinguish expired cache,
new useful context, or a provider-specific rewrite cause. No optimization, live
acceptance result, or savings claim follows from mock tests. Actual controlled
live reports are still required before claiming the issue's measured-improvement
acceptance criteria or changing rollout defaults.

## Free verification

```sh
VITEST_MAX_WORKERS=25% pnpm --filter @bike4mind/desktop exec vitest run src/main/chat/liveEvaluation.test.ts src/main/chat/evaluationBudget.test.ts src/main/chat/completions.test.ts src/main/chat/ChatService.usage.test.ts
node --test apps/desktop/scripts/test_controlled_cost_evaluation.cjs
pnpm --filter @bike4mind/desktop typecheck
```

The integration test drives actual ChatService local tool execution with mocked
completion streams and authoritative receipt lookup. It makes no provider calls.
