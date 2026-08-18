CONSTRUCTED, not captured: models.list needs a live Gemini key and none was
available. Field names, nesting, the models/<id> resource-path form and the
pagination contract come from the verified REST reference
(ai.google.dev/api/models, read 2026-07-26), which also states that a page holds
at most 1000 models however large a pageSize is passed. The model ids, token
limits and display names are the real current ones.

No Gemini deprecations parser ships. Unlike Anthropic, Google publishes no
markdown twin of its deprecations table: ai.google.dev/gemini-api/docs/deprecations.md
returns the JS-rendered HTML shell, so a parser there would be scraping a SPA.
Gemini lifecycle therefore comes from the aggregators plus the absence heuristic.
