---
title: Error Handling & Troubleshooting
description: How the Completions API reports errors and which ones to retry
sidebar_position: 7
---

# Error Handling & Troubleshooting

The in-app reference lists every status code and error body: [https://app.bike4mind.com/api/v1/docs](https://app.bike4mind.com/api/v1/docs). The raw spec is at [https://app.bike4mind.com/api/v1/openapi.json](https://app.bike4mind.com/api/v1/openapi.json). This page explains how errors behave.

## Two places an error can appear

**Before the stream opens.** The server validates the credential, scopes, rate limit, body, model and your credits before it calls the model provider. A failure here returns a JSON error body with a real HTTP status. No stream opens.

**After the stream opens.** The HTTP status is already 200 and stays 200. A failure arrives as one terminal `error` event in the stream:

```json
{ "type": "error", "message": "...", "requestId": "...", "code": "provider_error" }
```

An `error` event is not followed by `data: [DONE]`. A stream that ends with neither is incomplete.

Branch on the HTTP status and `errorCode` (JSON), or on the event's `code` (stream). Never branch on `error` or `message`: they are prose and can change. `code` is optional, so keep a default branch that shows `message` and logs `requestId`.

## Authentication and scopes

- **401** means the key is missing, malformed, revoked or expired. Create a new key from the Profile menu -> More -> API Keys. See [Authentication](./authentication.md).
- Body validation runs before authentication, so a malformed body returns 422 (or 400 for an empty `messages` array) even without credentials.
- **403** with `required_scopes` in the body means the API key does not hold any of the required scopes (`ai:chat` or `ai:generate`). Edit the key's scopes or create a new key.
- **403** without `required_scopes` can mean the account is suspended or under a dispute; contact support. JWT requests can also require MFA enrollment: complete enrollment in the web app. Changing key scopes does not resolve these account restrictions.

## Credits

- **422** with `errorCode: "insufficient_credits"` means you cannot afford the request: your personal balance, your organization's balance, or an organization per-member credit cap. Other 422 responses mean the body failed schema validation.
- On an open stream, running out of credits mid-generation arrives as an `error` event with `code: "insufficient_credits"`.
- B4M never returns 402.

Top up before retrying; the same request fails again until the balance or cap changes.

## Daily free-tier limit

HTTP 429 with `errorCode: "daily_free_limit_reached"` means your personal spending has reached
the free-tier daily allowance. Wait the `Retry-After` number of seconds before sending another
request; the allowance resets at midnight UTC. A positive credit balance does not override this
limit, and an immediate retry or a balance top-up alone does not reset it.

If you expected organization billing, check that the request or API key selects the intended
organization. Organization-billed turns are exempt from this personal limit. The limits are
deployment settings, so contact your deployment administrator if the allowance differs from the
[defaults](./reference.md#free-tier-daily-allowance).

## Stream error codes

| `code` | Meaning | Retry? |
|--------|---------|--------|
| `insufficient_credits` | Credits ran out mid-generation. | After a top-up |
| `invalid_request` | The provider rejected your input. | No, change the request |
| `content_blocked` | The model declined the request. | No, rephrase or pick another model |
| `provider_rejected` | The provider refused B4M's credentials. Your key is fine. | Later, or another model |
| `provider_error` | Any other provider failure. | Yes, with backoff |

## Account-level limits

Some accounts also have a tokens-per-minute limit and a limit on completions in flight at once. A 429 for one of these names it in `errorCode`:

- `token_rate_limit_exceeded`: wait for `Retry-After` seconds. A retry can be refused again while your usage in the last minute is still over the limit.
- `concurrency_limit_exceeded`: retry when one of your running completions finishes.

## Retry guidance

| Status | Retry? |
|--------|--------|
| 400, 401, 403, 413, 422 | No. Fix the request, key, scopes or balance first. |
| 429 | Yes. Wait `Retry-After` seconds. See [Account-level limits](#account-level-limits) for the `errorCode` values. |
| 500, 503 | Yes, with exponential backoff. A 503 with `errorCode: "provider_not_configured"` means the model's provider is unavailable here; try later or another model. |

Log the `request_id` from the error body (also sent as the `X-Request-ID` header) and include it when you contact support.

## Unknown model

A 400 with `errorCode: "unknown_model"` means the model id is not available to you. Check `GET /api/v1/models` for the ids you can use.

## Related

- [Streaming](./streaming.md)
- [Best Practices](./best-practices.md)
