LIVE CAPTURE of https://api.bfl.ai/openapi.json (unauthenticated), fetched
2026-10-23 and trimmed: 16 of the 30 paths, their request schemas, and per-
property descriptions removed. The 16 were picked to cover every branch the
parser takes - twelve prompt-taking models (all seven FLUX.2 endpoints plus
flux-pro-1.1, flux-pro-1.1-ultra, flux-kontext-pro, flux-dev and
flux-tools/vto-v2), one prompt-less image tool (flux-tools/erase-v1), one POST
that is account plumbing (delete_finetune), and two GET-only endpoints
(credits, get_result). No path or property name was edited.
