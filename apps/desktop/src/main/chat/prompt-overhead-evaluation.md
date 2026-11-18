# Desktop prompt overhead: deterministic baseline

## Decision

Keep runtime defaults unchanged. A smaller loaded start set is measurable with the
existing deferred loader, but reduced loaded-schema size is not reduced total cost
per accepted result. This delivery is baseline/evaluation work, not completion of
the provider-cost or rollout acceptance gates.

## Reproduce without provider spend

From `apps/desktop`, after building workspace dependencies:

```sh
B4M_PROMPT_BASELINE=1 VITEST_MAX_WORKERS=25% pnpm exec vitest run src/main/chat/requestFootprint.test.ts src/main/chat/ChatService.deferredTools.test.ts src/main/chat/ChatService.agentWake.test.ts
```

The matched fixture runs the real ChatService request assembly and local file read
with mocked completions. Both variants read the same single-character file, with
the same offered tools and scripted response, then replay history after creating a
new ChatService instance against the same SessionStore. This is a service restart,
not an Electron/process restart. The scripted response is not a model-quality
acceptance oracle. No model calls, credits, prices, or private workloads are used.

## Observed baseline

One deterministic paired fixture; character estimates use `ceil(JSON.length / 3)`.
These are serialization estimates, not provider tokenizer counts. Tool-change
messages are measured separately from stable textual system messages.

| Block | Start limit 100,000: bytes / estimate | Start limit 0: bytes / estimate |
| --- | ---: | ---: |
| Loaded tools | 22,987 / 7,663 | 2,268 / 756 |
| Deferred tools | 133 / 45 | 21,146 / 7,049 |
| System | 4,479 / 1,493 | 4,479 / 1,493 |
| History | 5,426 / 1,809 | 5,426 / 1,809 |
| Tool changes | 2 / 1 | 1,127 / 376 |
| Full first request | 33,431 bytes | 34,851 bytes |

Loaded-tool estimates fall by 6,907 (90.1%), while total request bytes grow by
1,420 (4.2%). Deferral moves schemas out of the loaded head; it does not remove
them from the HTTP request. The hypothesis that a smaller start set reduces HTTP
payload size is disproven for this fixture. No savings or quality claim follows.
Absolute request sizes can move with schema edits and temporary-path lengths;
the paired assertions intentionally test direction rather than exact byte totals.

The footprint helper returns only five fixed block names, byte counts, estimates,
and SHA-256 digests. The paired report omits digests of dynamically generated paths
and exports no prompts, paths, tool arguments, user IDs, task content, or model
response text. Digests are change detectors, not anonymization of arbitrary private
data; only sanitized fixtures should be published. No runtime logging is added.

## Coverage and unknowns

- Covered deterministically: fresh turn, warm replay, two-round tool loop,
  service restart, tool additions/removals, model/backend fallback, deferral
  rollback, withdrawn-tool refusal, instruction loading and cache-marker shape.
- Named regression failures distinguish loaded tools, deferred tools, system and
  history growth. System instructions are not stripped or rewritten.
- Unknown: real cache reads/writes by TTL, uncached input/output, provider-priced
  cost, actual cache expiry, failed paid attempts, accepted live results and
  end-to-end quality/latency. Cache flags and stable hashes do not prove a hit.
- Pending: sustained live loops, live worker creation/parent wakes, full process
  restart, pauses across 5-minute/1-hour TTL boundaries, changed instructions,
  compaction/summarization overhead and repeated matched accepted-result trials.
- Changing a block identifies changed serialized content, not whether a provider
  rewrote it. Stable content after a TTL pause cannot distinguish expired cache
  from another provider-side miss; without provider evidence the cause is unknown.

## Orchestration lifecycle fixture

The existing agent-wake suite now measures actual ChatService worker creation and
the queue-driven automatic wake of a parent after two workers finish. Completions
are mocked; the spawn, session persistence, completion notification and wake paths
are real. Synthetic user/project instructions are loaded for parent and workers;
the test asserts they remain present and workers inherit the parent approval mode.
It retains the existing exactly-once wake checks. No provider capability or cache
behavior is inferred from this `test-model`, nondeferred fixture.

| Stage | Loaded tools estimate | System estimate | History estimate |
| --- | ---: | ---: | ---: |
| Parent initial | 13,208 | 6,477 | 11 |
| Parent after spawn | 13,208 | 6,477 | 381 |
| Worker first | 11,806 | 5,202 | 13 |
| Worker second | 11,806 | 5,202 | 13 |
| Parent automatic wake | 13,208 | 6,477 | 731 |

Parent fingerprints change only for history after spawn and wake; loaded tools,
deferred tools, textual system and tool-change blocks are stable. Worker requests
are measured independently: equal lengths do not imply equal content or shared
provider cache. Generated session IDs and temporary paths remain private to the
test; opt-in exported records omit all fingerprints and contain fixed stage labels,
block sizes and explicit null provider usage/cost/live outcome.

This PR complements, rather than replaces, the reminder-deduplication optimization
in [the existing draft](https://github.com/Bike4Mind/bike4mind/pull/7770). It does
not copy its runtime changes. The request-footprint test has a different filename
to avoid an add/add collision with that draft's synthetic footprint fixture.
Character estimates here use JSON length divided by three for schemas and text;
the other draft uses the shared text estimator. Compare bytes or explicitly named
estimator outputs, not unlabeled token estimates between the reports.

## Controls and next evaluation boundary

No new loader, permission policy, instruction cap, TTL or compaction default is
introduced. The existing `B4M_DESKTOP_DEFERRED_TOOLS=0` disables deferral;
`B4M_DESKTOP_DEFERRED_TOOLS=1` plus
`B4M_DESKTOP_DEFERRED_START_MAX_TOKENS=0` selects the measured experimental shape.
Without overrides the existing server setting applies. Unsupported providers keep
their existing nondeferred shape. TTL and compaction remain independent controls.

Live comparisons require explicit authorization and a declared spend cap. Record
the repository revision, exact catalog model/backend, effort, pricing provenance,
TTL, timestamp, cache state, every attempt (including failures), and objective
acceptance checks. Preserve missing usage as unknown rather than zero. Include all
planning, output, cache writes/reads, review, repair and summarization in aggregate
cost divided by accepted results; undefined if none accepted. Compare both cold
and realistic warm/pause patterns before selecting an optimization or default.
