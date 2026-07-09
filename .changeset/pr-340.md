---
"@bike4mind/cli": minor
---

Version, document, and strictly validate the headless stream-JSON protocol.

Every headless event (and the `json` result/error object) now carries a
`schemaVersion` + stable `runId`; the full contract is documented in
`packages/cli/docs/headless-protocol.md`. Permission decisions surface in-band
as `permission_request` / `permission_decision` events, and a new
`--permission-policy` flag drives unattended runs without blanket
auto-approval.

Note: `B4M_ADDITIONAL_DIRS` is now validated strictly - a malformed value (not a
JSON array of strings) fails the run with a clear error instead of being
silently ignored.
