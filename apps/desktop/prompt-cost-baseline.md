# Desktop orchestration prompt baseline

## Scoped delivery

Live deferred tool-name changes omit a reminder only when its guidance text is
byte-identical to the previous live state. Tool addition/removal messages, changed
access guidance, declarations, persisted state, replay and permission checks keep
their existing behavior. This is independently testable without provider calls.

## Evidence boundary

This is an offline, sanitized request-shape baseline, not a provider-cost or
accepted-task benchmark. No paid requests were made. Estimated tokens use the
existing Desktop `estimateTextTokens` function, not a provider tokenizer.
Deferred definitions remain serialized on the Desktop-to-proxy request; their
length is not evidence that a provider charges them as loaded prompt tokens.

Reproduce from `apps/desktop` after building workspace dependencies:

```sh
B4M_PROMPT_BASELINE=1 VITEST_MAX_WORKERS=25% pnpm exec vitest run src/main/chat/promptFootprint.test.ts src/main/chat/deferredTools.test.ts src/main/chat/ChatService.deferredTools.test.ts --maxWorkers=1
```

The fixture uses a synthetic root, instructions and skill listing, actual Desktop
guidance and registry schemas, a zero-token optional start set, no media, and no
connected MCP schemas. It is intentionally smaller than a real user's setup.
Exported JSON contains fixed block categories, SHA-256 hashes, character lengths,
and token estimates, not prompt text, paths, IDs or task contents. Do not substitute
private prompts into an exported fixture: hashes and lengths are fingerprints,
not anonymization guarantees. No production prompt capture or logging is added.

With `B4M_PROMPT_BASELINE=1` the footprint test also enforces per-block token budgets
and prints the JSON report, so intentional guidance changes can be compared by hash.

## Deferred evaluation

This partial delivery does not establish overall prompt-cost savings or complete
the broader evaluation. Provider-reported usage and cache writes by TTL, realistic
pauses and cache expiry, worker/wake request baselines, and total cost per accepted
result remain unmeasured. Those require a separate authorized controlled evaluation;
the offline estimates above cannot substitute for it.
