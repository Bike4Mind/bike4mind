# Posting to Slack with an API key

`POST /api/v1/slack/messages` lets an external system (a build pipeline, a deploy job, an agent)
post status messages and thread replies to Slack as the Bike4Mind bot. The caller holds a
Bike4Mind API key, never a Slack token. The full request and response reference is in the
generated API docs (`/api/v1/docs`, operation `postSlackMessage`).

## What has to be true

A post goes through only when all of these hold:

1. The API key carries the `slack:post` scope.
2. The channel is in a Slack workspace connected to an organization the key's owner belongs to
   (the organization page, **Integrations** tab, Slack Workspace card). An organization-billed key must bill that same
   organization. Only workspaces connected through the organization integration qualify.
3. An organization owner has enabled the channel for API posting, optionally limited to listed
   API key ids. Every channel starts disabled.
4. The bot is a member of the channel. The bot can post only where it has been invited.

A refusal of 2 or 3 is a `403` with one message, so the endpoint never reveals whether a channel
id is configured somewhere the caller cannot see. A missing bot is a `409` with
`errorCode: "slack_bot_not_in_channel"`.

## 1. Invite the bot

In Slack, open the channel and run:

```text
/invite @<bot name>
```

For a private channel this must happen before step 2, because the bot cannot see the channel
until it is a member.

## 2. Enable the channel (organization owner)

In the web app, open your organization page, **Integrations** tab. On the Slack Workspace card, under **API posting**, paste
the channel ID (in Slack: channel name > View channel details, at the bottom of the About tab)
and select **Enable**. To restrict the channel to specific keys, list their key IDs in
**Limit to API key IDs**. The page warns you if the bot is not in the channel yet.

The same setting is available as a session-authenticated API for the organization owner:

```http
GET /api/organizations/{orgId}/integrations/slack/channels
PUT /api/organizations/{orgId}/integrations/slack/channels
Content-Type: application/json

{ "channelId": "C0123ABCDEF", "apiPostEnabled": true, "apiPostAllowedKeyIds": [] }
```

`PUT` checks the channel exists in the organization's workspace and answers with `botIsMember`
when enabling. Send `"apiPostEnabled": false` to turn posting off. Removing the channel's whole
configuration from the Slack App Home also turns posting off.

## 3. Mint a key with `slack:post`

Profile > API Keys > New key, then select **Slack: Post**. The scope is not part of the Read-only
or Read & write presets, so tick it explicitly. A key that only posts to Slack needs no other
scope. Store the key in your secret manager.

## 4. Post

```bash
curl -sS -X POST "https://<your-deployment>/api/v1/slack/messages" \
  -H "Authorization: Bearer $B4M_SLACK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "C0123ABCDEF",
    "text": "Shipped v1.4.2 to production",
    "blocks": [
      { "type": "section", "text": { "type": "mrkdwn", "text": "*Shipped v1.4.2 to production*\n- Faster export\n- Fixed login loop" } }
    ]
  }'
```

The response carries the message timestamp:

```json
{ "ok": true, "channel_id": "C0123ABCDEF", "ts": "1730000000.123456" }
```

Reply in that message's thread by sending its `ts` as `thread_ts`:

```bash
curl -sS -X POST "https://<your-deployment>/api/v1/slack/messages" \
  -H "Authorization: Bearer $B4M_SLACK_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "channel_id": "C0123ABCDEF", "text": "Smoke tests passed", "thread_ts": "1730000000.123456" }'
```

## Limits and behavior

- `text`: 1 to 3,000 characters, always required (it is the notification fallback for `blocks`).
- `blocks`: up to 50 Block Kit blocks and 40,000 serialized characters.
- `thread_ts`: Slack's `1234567890.123456` form.
- Unknown fields are rejected with `422`, as is any other validation failure.
- Broadcast mentions (`<!channel>`, `<!here>`, `<!everyone>`, user groups, and bare `@channel`,
  `@here`, `@everyone`) are posted as plain text that notifies nobody. `<@U...>` user mentions
  are kept.
- Each key may post 30 messages a minute and 1,000 a day, on top of the key's own request limits.
  Over the limit is a `429` with `Retry-After`.
- Logs record the key id, organization, channel, `ts` and outcome. Message bodies and tokens are
  never logged.
