# Desktop prompt overhead: deterministic baseline

How to measure where Desktop request bytes go, per prompt block, without any
provider spend. This is measurement only; it changes no runtime default.

## Controlled evaluation preparation

From the repository root, after `pnpm install --frozen-lockfile` and
`pnpm turbo:core:build` (safe default is dry-run):

```sh
node apps/desktop/scripts/controlled-cost-evaluation.cjs --dry-run
node --test apps/desktop/scripts/test_controlled_cost_evaluation.cjs
```

The first command runs the `controlledCost` tests in `ChatService.usage.test.ts`, using real Desktop
ChatService assembly, SessionStore, local file_read, warm replay, service recreation
and forced compaction. Only the authenticated transport and model catalog are
scripted. No direct provider/proxy HTTP call substitutes for Desktop. Both user
instructions and files are synthetic isolated fixtures, deleted after each arm.
Sessions are pre-named to avoid auxiliary title-generation requests.
The catalog entries are capability fixtures, NOT verified available live models.
The 100,000-token reference is an explicit fixture setting, not a measured server
default. Unsupported deferred/TTL configurations collapse into duplicate effective
arms instead of being run or billed again. The compaction arm changes only manual
compaction; TTL-only changes only the requested TTL; no runtime defaults change.

The JSON report allowlists block names/sizes/estimates, model/arm labels, attempts
and scripted acceptance counts. It omits hashes, prompts, outputs, arguments,
paths, credentials and session IDs. Every transport invocation is included,
including a terminal scripted failure and the extra compaction request. One
scripted reading task and one failed task form each arm; warm/recreated turns
belong to the reading task. Scripted acceptance is not live quality evidence.
Unknown provider usage, cache writes by TTL, provider cost, platform charges and
cost per accepted live result remain null, not zero. Cache flags are not hits.

### Live gate and remaining blockers

All non-dry-run arguments, including `--live` and purported budget proofs, exit 2
before starting Vitest. There is deliberately no paid transport, secret reader,
boolean budget-verification override or live execution path in this preparation.
This is runnable offline preparation, not a completed live evaluator.

The [November 22 authorization](https://github.com/Bike4Mind/bike4mind/issues/6784)
and [pre-spend matrix](https://github.com/Bike4Mind/bike4mind/issues/6784#issuecomment-7091103354)
require an externally enforced aggregate $150 cap on dedicated credential routing,
including retries, workers, wakes, summaries and cache rebuilds, with no shared-key
fallback. No verifier for that enforcement exists here. Alerts, local counters,
window rate limits and a hand-authored `verified` flag are insufficient.

Before adding any paid path, the evaluation owner and provider administrator must
supply verifiable aggregate remaining-budget enforcement and isolated routing.
Pin exact available catalog model IDs, generation settings and pricing snapshots
from ModelCatalog; broad sweep uses gpt-6.1-sol first, Opus only after review for
the final matched comparison. Provider-priced cost must remain distinct from
platform `usdCost`/credits. ChatService usage events are cumulative across a turn;
do not sum them as individual request bills. Capture request-scoped usage including
failed requests and auxiliary summaries, retaining absent TTL breakdowns as unknown.
Unknown/ambiguous bills must block further paid requests until reconciled.

Still missing: live credential/budget verifier and transport, full matrix task seeds
and deterministic quality rubrics, live per-request usage/pricing reconciliation,
actual TTL-boundary pauses, fresh OS-process restart, sustained long-loop quality,
tool-set-change and worker/wake integration into this report. The existing suites
below cover deterministic worker/wake/replay behavior separately. Nothing here
establishes savings or completes the issue's live-cost acceptance criteria.

## Reproduce

From `apps/desktop`, after building workspace dependencies:

```sh
B4M_PROMPT_BASELINE=1 VITEST_MAX_WORKERS=25% pnpm exec vitest run src/main/chat/requestFootprint.test.ts src/main/chat/ChatService.deferredTools.test.ts src/main/chat/ChatService.agentWake.test.ts
```

With `B4M_PROMPT_BASELINE=1` the deferred-tools suite prints a sanitized comparison
of the same reading task at deferred start limits of 100,000 and 0: per-block bytes
and estimates plus total request bytes. The agent-wake suite prints an
`orchestration-request-shape` report with per-block bytes and estimates for the
parent's first request, the parent after spawning workers, both workers and
the parent's automatic wake. Without the variable nothing is printed.

## Method

- The test-only `test-utils/requestFootprint.ts` splits a request into five fixed blocks
  (loaded tools, deferred tools, textual system, history, tool changes) and reports
  UTF-8 bytes, Desktop's shared `estimateTextTokens` estimate over serialized JSON
  and a SHA-256 per block. It stays outside runtime source and is imported only by
  tests. The estimate is not a provider token count.
- The complementary tool-state reminder baseline uses the same shared estimator
  over its own named text blocks. Its block boundaries and serialization differ;
  compare matched blocks, not totals across the two fixtures.
- The fixtures run the real ChatService request assembly, local file read, worker
  spawn and parent wake with mocked completions. A "restart" is a new ChatService
  on the same SessionStore, not a process restart.
- The printed report carries only block names, sizes and estimates. It omits
  digests, prompts, paths, tool arguments and model output.

## What the fixtures assert

- A zero start set shrinks the loaded-tools block. Deferral moves schemas out of
  the loaded head but does not remove them from the HTTP request, so total request
  bytes are reported, not asserted.
- The leading cached prefix is byte-stable across turns and a service restart.
- A parent's tool and system blocks stay stable across worker spawn and automatic
  wake; only history changes.

## Not covered

Real cache reads/writes and TTL expiry, provider-priced cost, failed paid
attempts, accepted live results, quality/latency, full process restart and
compaction overhead. Stable hashes and cache flags do not prove a cache hit.

## Controls

`B4M_DESKTOP_DEFERRED_TOOLS=0` disables deferral. `B4M_DESKTOP_DEFERRED_TOOLS=1`
plus `B4M_DESKTOP_DEFERRED_START_MAX_TOKENS=0` selects the measured experimental
shape. Without overrides the server setting applies.
