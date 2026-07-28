Captured from GET https://api.moonshot.ai/v1/models on 2026-07-28, trimmed to the
ids that matter for the normalizer. The endpoint is OpenAI-shaped and returns
nothing but id / object / owned_by - no pricing, no context window - which is why
the kimi source is an availability signal only and the aggregators carry
everything else.

unknown-namespace.json is hand-written, not captured: it pins the fail-closed
behavior for an id whose modality the namespace does not state.
