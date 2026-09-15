LIVE CAPTURE of models.dev/api.json, fetched 2026-07-26 (ETag
97c7bbb38bbf69bf51d022718f331faf), trimmed from 172 providers / 5,755 models to
6 providers / 27 models. No value was edited; per-provider metadata is reduced to
id, name and env. The subset covers cost with and without tiers, status:
deprecated, temperature gating, the modalities map, and the amazon-bedrock
namespace that fills the AWS pricing hole. The `openrouter` provider is included
precisely because it must NOT be indexed: it is not one a ModelBackend maps to.
