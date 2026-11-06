---
title: API Reference
description: How the B4M Completions endpoint works, with a link to the full machine-generated reference
sidebar_position: 3
---

# API Reference

The full, always-current reference for every field and status code is the in-app API reference, generated from the same contract the server enforces:

- **Interactive reference:** [https://app.bike4mind.com/api/v1/docs](https://app.bike4mind.com/api/v1/docs) (public, no API key needed)
- **Raw OpenAPI spec:** [https://app.bike4mind.com/api/v1/openapi.json](https://app.bike4mind.com/api/v1/openapi.json)

This page covers the concepts. Use the in-app reference for field names, types and the complete list of status codes.

## Endpoint

```text
POST https://app.bike4mind.com/api/ai/v1/completions
```

Send a JSON body with a `model` and a `messages` array. Other options (tools, extended thinking, token limits) are listed in the in-app reference. Message `content` can be a string or an array of parts, including images.

## Authentication

Send your API key as `Authorization: Bearer b4m_live_<key>`, or with the legacy `x-api-key: b4m_live_<key>` header. The two are equivalent. The key needs the `ai:chat` or `ai:generate` scope. See [Authentication](./authentication.md) for how to create a key (Profile menu -> More -> API Keys).

## Choosing a model

Call `GET /api/v1/models` with your API key to list the model ids you can use. The list depends on which providers the deployment and your own provider keys enable, so if a sample returns 400 `unknown_model` or 503 `provider_not_configured`, use an id from that list. An unknown model returns a 400 with `errorCode: "unknown_model"`; a catalogued model whose provider is not configured returns 503 `provider_not_configured`.

After adding or activating a provider key, allow up to 60 seconds for `GET /api/v1/models` to reflect it: model lists are cached per user.

## Response

A successful request is always answered with a server-sent event stream (`text/event-stream`), whether or not you set a `stream` flag. The stream carries a `meta` event, then `content` and `tool_use` events with `usage` and `credits`, and ends with `data: [DONE]`. The last `content` event carries `usage` and `credits`. The final `content` event also carries `stopReason` when the provider reports one. `max_tokens` means the reply was truncated (raise `max_tokens` or reduce thinking); an absent `stopReason` means unknown, not truncated. `degenerate_repetition` is an aborted repeating reply, `refusal` is a declined request, and `pause_turn` requires continuation rather than publishing a final answer. See [Streaming](./streaming.md) for how to parse it.

## Credits

Each request is charged to your personal credit balance, or to your organization's balance when you work under an organization. An organization can also set a per-member credit cap.

- **Before the stream opens**, a request you cannot afford fails with HTTP 422 and `errorCode: "insufficient_credits"`. It is never 402.
- **During the stream**, if credits run out mid-generation, the status is already 200, so the failure arrives as a final in-band `error` event with `code: "insufficient_credits"`.

Either way, top up your balance (or ask your organization admin to raise the cap) before you retry. Retrying unchanged will fail again.

### Free-tier daily allowance

When credit enforcement is enabled, free-tier accounts also have a daily personal-spend allowance.
Once your recorded spend reaches it, new requests return HTTP 429 with
`errorCode: "daily_free_limit_reached"` and a `Retry-After` header in seconds until midnight UTC.
The request that crosses the allowance is allowed to finish; concurrent requests can overshoot it.

The default allowance is 500 credits for accounts under 24 hours old, 300 credits from 24 hours
to under seven days old, and 200 credits thereafter. Your deployment administrator can change
these limits. Paid ladder-tier subscribers and organization-billed requests are exempt; organization
spend does not count toward your personal allowance. See [Troubleshooting](./errors.md#daily-free-tier-limit).

## Rate limits and size

Each API key has a per-minute and a per-day request limit; the in-app reference lists the defaults. Exceeding either returns `429` with a `Retry-After` header in seconds. On this endpoint the `X-RateLimit-Limit-*`, `X-RateLimit-Remaining-*` and `X-RateLimit-Reset-*` headers (`Minute` and `Day` variants, reset as Unix epoch seconds) are sent only on an API-key `429`, not on successful responses. A request body over the size limit returns `413`. The in-app reference describes the limits shared across endpoints: [https://app.bike4mind.com/api/v1/docs](https://app.bike4mind.com/api/v1/docs).

## Errors

Anything checked before the model provider is called fails with a JSON body and a real HTTP status, and no stream opens:

- 401: missing or invalid credentials.
- 403: with `required_scopes` in the body, the API key lacks a scope. Without it, the account may be suspended or under a dispute (contact support), or a JWT caller may need to enroll in MFA in the web app.
- 422: the body failed schema validation, or insufficient credits (see above).
- 429: rate limited. Wait `Retry-After` seconds.

After the stream opens, a failure is a single terminal `error` event. See [Errors](./errors.md) for the event shape and retry guidance, and the in-app reference for every status code.
