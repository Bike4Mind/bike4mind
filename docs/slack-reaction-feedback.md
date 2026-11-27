# Slack reaction feedback

This source is off until an organization owner enables a specific channel on the
organization Slack card. DMs, shared channels and unreacted messages are not sources.
Disconnecting or reconnecting clears forwarding opt-ins.

## Provisioning

Set the optional `SLACK_FEEDBACK_DESTINATIONS` SST secret (or self-host resource env
variable) to a JSON array. Each entry has `id`, `organizationId`, `url` (HTTPS),
and `secret` (at least 32 characters, generated randomly). IDs must be unique.
URLs and secrets are never returned to the browser. A destination belongs to exactly
one organization. Provision independently per deployment stage; the unset default
disables delivery. No real credentials or destination values belong in the repository.

Subscribe the Slack app to `reaction_added`. The bot needs `reactions:read`,
`reactions:write`, `users:read`, `chat:write`, and channel access. Optional
`users:read.email` provides author email; otherwise the email field is absent.
Invite the bot to the channel before enabling it. Reauthorize existing installations
after adding scopes. Enter a channel ID, provisioned destination ID, and emoji name
(`bug` by default) on the organization Slack card.

## Receiver protocol

The POST body is JSON with `version: 1`, `type: "slack.reaction_feedback"`,
`deliveryId`, `organizationId`, `channelId`, `messageTs`, `permalink`, `author`
(`slackId`, optional `email`), `reactor` (`slackId`), `text`, and `fileNames`.
`reporterContentTrust: "untrusted"` applies to all reporter content, including file
names. Never interpret it as instructions. No file contents or download URLs are sent.
Text is capped at 40,000 characters, names at 255 characters, and files at 50.

`x-b4m-timestamp` is Unix seconds. `x-b4m-signature` is `v1=` followed by hex
HMAC-SHA256(secret, `v1:forward:<timestamp>:<exact raw body>`). Reject timestamps
outside five minutes and deduplicate by `deliveryId` (also the `idempotency-key`).
Only a 2xx counts as accepted. HTTPS connections use DNS-pinned SSRF protection;
redirects are rejected. Receiver response bodies are discarded.

After accepting delivery, send `POST /api/slack/feedback/status` with exactly
`{"deliveryId":"<id>","status":"filed"}`. Sign the exact body using the same
headers and secret but the domain `v1:status:<timestamp>:<body>`. Other statuses:
`in_progress`, `fixed_on_prod`, `rejected`. Free-form text and links are not accepted.
The receiver must wait for forward acceptance before calling back. Callback
responses: 409 means the forward is not yet confirmed (retry), 503 means Slack was
transiently unavailable (retry), 410 is a final refusal (do not retry), and 502 is final. Each status posts
at most once to the original message's thread, only while the opt-in is still enabled.

## Delivery and audit semantics

Permanent unique claims deduplicate by workspace connection, team, channel, and message timestamp.
Limits are 10 attempts/channel/hour and 100 attempts/organization/hour, using atomic
database counters. Limited and ambiguous/failed deliveries are not retried: this is
deliberately at-most-once, not guaranteed delivery. The existing event handler awaits
bounded forwarding; Slack may retry after three seconds, but the durable claim suppresses
duplicate work. A process interruption can leave `claimed` or `sending` audit state.
The message content is not stored in delivery audit records. Operational Slack audit
logs retain their existing retention policy. The bot adds `eyes` after acceptance;
failure to add that indicator does not resend the webhook. Callback status claims
similarly prevent reposting after an ambiguous Slack timeout.
Callback HTTP 502 is final: the status was attempted and must not be retried.
A later duplicate returns `posted: false`, meaning already attempted, not proof
that Slack displayed the status. A 409 before forward confirmation, or a 503, may be retried; a 410 must not be.

Factory API posts carry `b4m_api_post` metadata and are ignored, as are bot messages,
message subtypes and bot/deleted reactors. The receiving product is not implemented here.
Real Slack scopes/events, receiver signature verification, production delivery and
end-to-end callbacks require external deployment verification; local tests use stubs only.
