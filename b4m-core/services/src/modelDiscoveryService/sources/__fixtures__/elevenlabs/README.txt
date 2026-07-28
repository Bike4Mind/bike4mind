CONSTRUCTED: GET /v1/models needs an xi-api-key and none was available (an
unauthenticated call returns 404 workspace_not_found, captured 2026-07-26). The
field set is the 17-field response documented in spec sec 3 and in the public
ElevenLabs API reference: an unwrapped ARRAY of model objects, model_id / name /
description / the can_* capability booleans / token_cost_factor / the three
character limits / languages[] / model_rates / concurrency_group. Model ids and
names are the real current ones.
