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

List endpoints accept `page` and `limit` query parameters and return a `pagination` object alongside the items.

## Errors

Errors use standard HTTP statuses. See [Error Handling](./errors.md). Running out of credits is a 422 with `errorCode: "insufficient_credits"` (never 402).

A 403 means missing permissions or scopes.

## Real-time updates

Real-time features use WebSockets rather than polling. See the [Agent System](./agents.md) page for the events agents emit.
