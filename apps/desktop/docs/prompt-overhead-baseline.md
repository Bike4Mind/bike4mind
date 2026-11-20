# Desktop prompt overhead: deterministic baseline

How to measure where Desktop request bytes go, per prompt block, without any
provider spend. This is measurement only; it changes no runtime default.

## Reproduce

From `apps/desktop`, after building workspace dependencies:

```sh
B4M_PROMPT_BASELINE=1 VITEST_MAX_WORKERS=25% pnpm exec vitest run src/main/chat/requestFootprint.test.ts src/main/chat/ChatService.deferredTools.test.ts src/main/chat/ChatService.agentWake.test.ts
```

With `B4M_PROMPT_BASELINE=1` the deferred-tools suite prints a sanitized comparison
of the same reading task at deferred start limits of 100,000 and 0: per-block bytes
and estimates plus total request bytes. Without it nothing is printed.

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
