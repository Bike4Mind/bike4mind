model-deprecations.md and pricing.md are LIVE CAPTURES, fetched 2026-07-26 from
docs.claude.com (which 302s to platform.claude.com) and trimmed to the tables the
parsers read plus one table they must NOT read (batch pricing, so picking the
wrong table fails a test). No edits to any row.

pricing-sonnet-5-standard.md is a second LIVE CAPTURE of the pricing page,
fetched 2026-10-19, trimmed to the model pricing table and its footnotes. It is
kept separate so pricing.md stays an unedited capture: it shows the two dated
Claude Sonnet 5 rows collapsed into one row with footnote markers on the rates.

models.json and page-2.json are CONSTRUCTED: /v1/models needs a live Anthropic
key and none was available. The response shape - including the nested
capabilities tree, its `supported` leaves and the thinking `types` map - is taken
verbatim from the typed ModelInfo the @anthropic-ai/sdk 0.111.0 this repo depends
on declares (resources/models.d.ts), so it is the shape the API returns rather
than a guess. Model ids, display names and token limits are the real ones.
