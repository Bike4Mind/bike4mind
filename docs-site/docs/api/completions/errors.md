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

- **422** with `errorCode: "insufficient_credits"` means you cannot afford the request: your personal balance, your organization's balance, or an organization per-member credit cap. A 422 with `errorCode: "run_budget_exhausted"` is a run budget, not your balance; see [Runs](#runs). Other 422 responses mean the body failed schema validation.
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

Your key has a per-minute and a daily request limit. Some accounts also have a tokens-per-minute limit and a limit on completions in flight at once. A 429 for one of these names it in `errorCode`:

- `api_key_rate_limit_exceeded`: the key's per-minute request limit. Wait for `Retry-After` seconds.
- `api_key_daily_limit_exceeded`: the key's daily request limit. Wait for `Retry-After` seconds.
- `token_rate_limit_exceeded`: wait for `Retry-After` seconds. A retry can be refused again while your usage in the last minute is still over the limit.
- `concurrency_limit_exceeded`: retry when one of your running completions finishes.

A 429 body for the request and token limits may also carry `limit` (the limit that was hit) and `windowSeconds` (its window). A concurrency refusal carries `limit` only.

## Retry guidance

| Status | Retry? |
|--------|--------|
| 400, 401, 403, 413, 422 | No. Fix the request, key, scopes or balance first. |
| 404 with `run_not_found` | No. Resend without `run`, or use a run you created. On `GET /api/v1/completion-runs/{runId}/usage`, read a run you created. |
| 422 with `run_budget_exhausted` | After the run's running requests finish, or after you raise the run budget. |
| 429 | Yes. Wait `Retry-After` seconds. See [Account-level limits](#account-level-limits) for the `errorCode` values. |
| 500, 503 | Yes, with exponential backoff. A 503 with `errorCode: "provider_not_configured"` means the model's provider is unavailable here; try later or another model. |

Log the `request_id` from the error body (also sent as the `X-Request-ID` header) and include it when you contact support.

## Runs

A 404 with `errorCode: "run_not_found"` means the `run.runId` in your request is not a run you created. It is returned before any credit hold or provider call, so nothing is charged. It is not retryable unchanged: resend without `run`, or mint a new run with `POST /api/v1/completion-runs`. See [Streaming](./streaming.md#settled-event).

`GET /api/v1/completion-runs/{runId}/usage` returns the same 404 for a run you did not create, including one that does not exist. It is a read, so nothing is charged either way.

A run minted with `budgetCredits` caps what all of its completions may claim together. Each completion claims what its answer can cost before the model is called, and returns the unused part when it finishes. The claim is priced from an estimate of the input, so a completion that costs more than it claimed is still charged its actual cost to your balance, up to what the balance can pay, and the run can go over its budget by that amount. The run counts it, and refuses later requests it can no longer cover. A 422 with `errorCode: "run_budget_exhausted"` means the run's settled charges plus the claims of requests still running leave too little for even a short answer. Nothing is charged. Retry once those requests finish, or raise the budget with `POST /api/v1/completion-runs/{runId}/budget`. Buying credits does not raise a run budget. `GET /api/v1/completion-runs/{runId}/usage` reports the run's `budget` state. On a deployment that does not charge credits, the budget is not enforced and the `budget` block stays at zero committed credits.

## Unknown model

A 400 with `errorCode: "unknown_model"` means the model id is not available to you. Check `GET /api/v1/models` for the ids you can use.

## End user id not allowed

A 400 with `errorCode: "end_user_id_not_allowed"` means the request sent `end_user_id` on an API key without the `ai:end-user-id` scope, or with a signed-in session. Remove the field, or ask your administrator to grant the scope to the key. See [End users of your product](./reference.md#end-users-of-your-product).

## Invalid end user id

A 400 with `errorCode: "invalid_end_user_id"` means `end_user_id` was empty, longer than 64 characters, or contained anything other than letters, digits, `_`, `:` and `-` (an email address is never valid). This is checked before the credential, so it applies to every caller. See [End users of your product](./reference.md#end-users-of-your-product).

## Related

- [Streaming](./streaming.md)
- [Best Practices](./best-practices.md)
