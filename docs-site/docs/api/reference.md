# API Reference

The two API surfaces have different references:

- **Completions API** (API key): the public, contract-generated reference is at [https://app.bike4mind.com/api/v1/docs](https://app.bike4mind.com/api/v1/docs), with the raw spec at [https://app.bike4mind.com/api/v1/openapi.json](https://app.bike4mind.com/api/v1/openapi.json). It lists every field and status code. See also [Completions API](./completions/index.md).
- **Platform REST API** (JWT): the endpoints the web app itself uses. They are not individually documented here; see the sections below for conventions.

## Base URL

```text
https://app.bike4mind.com/api
```

Self-hosted instances use their own domain.

## Authentication

Platform endpoints require a JWT unless noted otherwise:

```http
Authorization: Bearer <jwt-token>
```

See [Authentication & Authorization](./auth.md). Completions endpoints use API keys instead; create one from the Profile menu -> More -> API Keys.

## Example

List your agents (see [Agent System](./agents.md)):

```bash
curl https://app.bike4mind.com/api/agents \
  -H "Authorization: Bearer $JWT_TOKEN"
```

## Pagination

`GET /api/agents` accepts `page` (default 1) and `limit` (default 10) query parameters and returns `{ data, hasMore, total }`: the items for the page, whether more pages follow, and the total match count. The handler sets no maximum for `limit`.

## Errors

Errors use standard HTTP statuses. See [Error Handling](./errors.md). Running out of credits is a 422 with `errorCode: "insufficient_credits"` (never 402).

On the completions endpoint, a 403 with `required_scopes` means the key lacks a scope. Without it, the account may be suspended or under a dispute (contact support), or a JWT caller may need to enroll in MFA in the web app.

## Real-time updates

Real-time features use WebSockets rather than polling. See the [Agent System](./agents.md) page for the events agents emit.
