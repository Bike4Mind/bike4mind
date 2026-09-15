CONSTRUCTED, not captured: /v1/language-models and friends need a live xAI key
and none was available. Every field name, nesting and unit here comes from the
verified xAI REST reference (docs.x.ai/developers/rest-api-reference/inference/models,
read 2026-07-26) and the spec sec 3 research summary; the /v1/embedding-models
shape is the one sec 3 documents, since that endpoint is absent from the public
reference. The token prices are the real published rates so the unit-conversion
tests check against something true: Grok 4 is $3 / $15 per MTok and Grok 4.5 is
$2 / $6 base with $4 / $12 over the 200K long-context threshold and $0.50 cache
reads (the same numbers the xaiBackend adapter table carries).
