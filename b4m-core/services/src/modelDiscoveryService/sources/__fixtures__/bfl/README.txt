LIVE CAPTURE of https://api.bfl.ai/openapi.json (unauthenticated), fetched
2026-07-26 and trimmed: 10 of the 26 paths, their request schemas, and per-
property descriptions removed. The 10 were picked to cover every branch the
parser takes - five prompt-taking models, one prompt-less image tool
(flux-tools/erase-v1), one prompt-taking tool under a nested path
(flux-tools/vto-v2), one POST that is account plumbing (delete_finetune), and two
GET-only endpoints (credits, get_result). No path or property name was edited.
