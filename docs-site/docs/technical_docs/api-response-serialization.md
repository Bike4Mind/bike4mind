---
title: Unified API Response Serialization
description: Design direction for a shared response/error envelope across the public API's HTTP and SSE transports
sidebar_position: 1
tags: [architecture, api, serialization]
---

# Unified API Response Serialization

**Status:** Design direction (tracking). No application code changes ship with this doc.
**Source:** [GitHub issue #80](https://github.com/Bike4Mind/bike4mind/issues/80)

## Why this doc exists

The public API is served by two transports that share auth, rate-limiting, and business logic
through `@bike4mind/services`, but each transport serializes responses and errors on its own.
That divergence means every hardening change (a new error field, a new header, a new metadata
value) has to be implemented and tested twice, and the two shapes drift further apart each time.

This doc is the design direction those future changes should move toward. It does not implement
anything. It describes:

- the divergence as it exists today,
- a target shape (`ResponseEnvelope` plus two transport serializers),
- the one architectural constraint that shape has to respect (SSE header flush timing),
- an explicit decision on error taxonomy,
- and a migration path that does not break existing clients.

## Correction vs. the original issue

Issue #80 describes the second transport as "direct Lambda functions
(`apps/client/server/cli/*`)" with its serializer in `apps/client/server/cli/completions.ts`.
That Lambda (`cliLlmHandler`) has since been removed. The public completions endpoint
(`POST /api/ai/v1/completions`) is now served by an always-on Fargate/Express service at
`apps/client/server/chatCompletion/external/route.ts` (see the header comment at the top of that
file). The divergence itself is real and still unresolved -- it is just Next.js Pages-API vs. the
Fargate SSE service now, not Next.js vs. Lambda.

## Current state: the two transports

1. **Next.js Pages-API** (`apps/client/pages/api/**`), wired through
   `apps/client/server/middlewares/baseApi.ts`. Errors are serialized by the `onError` handler in
   `apps/client/server/middlewares/errorHandler.ts`.
2. **ChatCompletion SSE service** -- the Fargate/Express service at
   `apps/client/server/chatCompletion/external/route.ts`, serving
   `POST /api/ai/v1/completions`. It streams SSE using helpers from `@bike4mind/common`
   (`buildMetaEvent`, `buildSSEEvent`, `formatSSEError`, `serializeSSEEvent`, `SSE_DONE_SIGNAL`)
   defined in `b4m-core/common/src/utils/sseEvents.ts`.

### Divergence today

| Concern | Next.js (`errorHandler.ts`) | SSE service (`sseEvents.ts` / `route.ts`) |
|---|---|---|
| Error body shape | `{ ...additionalInfo, name, error: <message>, request_id }` JSON | `{ type: 'error', message, requestId? }` SSE event |
| Error field naming | `request_id` (snake_case) | `requestId` (camelCase) -- naming skew between transports |
| Rate-limit headers | Six `X-RateLimit-*` headers set by `apiKeyRateLimit.ts` (`X-RateLimit-Limit-Minute`, `-Remaining-Minute`, `-Reset-Minute`, `-Limit-Day`, `-Remaining-Day`, `-Reset-Day`) | None -- and cannot be, see [SSE header-flush constraint](#the-sse-header-flush-constraint) below |
| `X-Request-ID` | Set on the response header by `logging.ts` | Emitted as an SSE `meta` event (first event on the stream) |
| Logger setup | `req.logger` injected by `logging.ts`, backed by global `Logger.resetMetadata()` | A per-request `new Logger({...})` instance, updated via `updateMetadata` |

### What is already unified

Request-ID correlation is already shared across both transports. Both resolve the ID with the
same utility, `resolveRequestId` in `b4m-core/common/src/utils/requestId.ts`, and both accept the
same two inbound header names (`REQUEST_ID_HEADER`, `LEGACY_REQUEST_ID_HEADER`). Next.js echoes
the resolved ID as the `X-Request-ID` response header (`logging.ts`); the SSE service emits it as
a `meta` event immediately after the stream opens and attaches it to every `error` event
(`route.ts`, `sseEvents.ts`).

This means the issue's original "will be unified" is already true for request IDs. The pattern
that shipped, though, is a **shared utility function consumed independently by each transport**
-- not a full envelope type with transport adapters. That distinction matters for the
recommendation below.

## Proposed design

### `ResponseEnvelope`

A single type in `@bike4mind/common` describing every response, success or error, on either
transport:

```ts
type ResponseEnvelope<T> = {
  data?: T;
  error?: {
    type: ErrorType;
    code: string;
    message: string;
    request_id: string;
    doc_url?: string;
  };
  meta: {
    request_id: string;
    rate_limit?: {
      limit: number;
      remaining: number;
      reset: number;
    };
  };
};
```

`@bike4mind/common` is a leaf package with no Express/HTTP dependency, so the envelope type and
any pure functions that build or map it (see [error taxonomy](#error-taxonomy) below) belong
there. Building on it are two transport serializers, one per wire format:

- **`serializeAsHttp(envelope, res)`** -- sets the HTTP status code, sets
  `X-Request-ID` and (when `meta.rate_limit` is present) the six `X-RateLimit-*` headers, and
  writes the envelope as the JSON body.
- **`serializeAsSSE(envelope, stream)`** -- emits a `meta` event (carrying `meta.request_id` and,
  when present, `meta.rate_limit`), then a `data` or `error` event depending on which field the
  envelope carries, then the existing `SSE_DONE_SIGNAL`.

A serializer that touches an Express `Response` or a stream is not a leaf-package concern, so
these two functions live in `@bike4mind/services` (which both transports already depend on for
business logic), not in `@bike4mind/common`. Introducing a new `@bike4mind/transport` package is
an alternative worth considering if the serializers grow enough surface area (framework-specific
helpers, content negotiation, etc.) to warrant their own dependency boundary -- but `@bike4mind/services`
is sufficient for the two functions described here and avoids adding a package for two functions.
The final call is left to whoever implements this; it is not blocking for this doc.

Existing entry points become thin callers of these serializers: `errorHandler.ts` builds an
envelope from the caught error and calls `serializeAsHttp`; the `formatSSEError`/`buildSSEEvent`
call sites in `route.ts` build an envelope and call `serializeAsSSE`.

### The SSE header-flush constraint

`route.ts` calls `res.flushHeaders()` immediately after setting the SSE content headers (Content-Type,
Cache-Control, Connection) and before request-body validation, authentication, or rate-limit
checking run. This is intentional: it establishes the stream (and sends an initial keep-alive and
`meta` event) before any of that pre-LLM work can trip an intermediary's connection timeout.

The consequence is structural, not a missing feature: **once headers are flushed, no further HTTP
header -- including any `X-RateLimit-*` header -- can be sent on that response.** The rate-limit
header gap on the SSE transport is not an oversight to "unify away"; it is forced by the transport's
own timing contract, and the unified design has to accept it rather than paper over it.

The envelope handles this by carrying rate-limit data in `meta.rate_limit`, a field, not a
transport-specific header. `serializeAsHttp` maps `meta.rate_limit` to the six `X-RateLimit-*`
response headers. `serializeAsSSE` instead emits it as part of the `meta` stream event -- so an SSE
client that wants rate-limit visibility reads it from the `meta` event's payload, and an HTTP
client keeps reading response headers exactly as it does today. Neither transport is asked to do
something its wire format cannot support.

### Error taxonomy

`HTTPError` (`b4m-core/common/src/errors.ts`) currently exposes only `statusCode`, `message`,
`name`, and `additionalInfo`. There is no `code` or `type` field on it or any of its subclasses
(`NotFoundError`, `UnprocessableEntityError`, `BadRequestError`, `UnauthorizedError`,
`ForbiddenError`, `TooManyRequestsError`, `CorruptedFileError`, `InternalServerError`), and no
`ErrorType` enum exists in `@bike4mind/common` today.

This doc defines the taxonomy now rather than deferring it, so the first implementing PR does not
have to re-litigate naming:

```ts
enum ErrorType {
  ValidationError = 'validation_error',
  AuthenticationError = 'authentication_error',
  AuthorizationError = 'authorization_error',
  NotFoundError = 'not_found_error',
  RateLimitError = 'rate_limit_error',
  ServerError = 'server_error',
}
```

Mapping from existing `HTTPError` subclasses:

| Subclass | `ErrorType` | `code` |
|---|---|---|
| `BadRequestError` | `ValidationError` | `bad_request` |
| `UnprocessableEntityError` | `ValidationError` | `unprocessable_entity` |
| `UnauthorizedError` | `AuthenticationError` | `unauthorized` |
| `ForbiddenError` | `AuthorizationError` | `forbidden` |
| `NotFoundError` | `NotFoundError` | `not_found` |
| `TooManyRequestsError` | `RateLimitError` | `rate_limited` |
| `CorruptedFileError` | `ValidationError` | `corrupted_file` |
| `InternalServerError` / unmapped | `ServerError` | `internal_error` |

This mapping is a pure function (`HTTPError -> { type, code }`) with no Express dependency, so it
belongs in `@bike4mind/common` alongside the envelope type -- both serializers call it, neither
owns it.

## Migration path

The request-ID precedent (a shared utility consumed independently by each transport, not a full
envelope) worked because it was a single field with no compatibility risk: both transports were
already free to add a header/event without touching their existing response shape. The envelope
is a bigger step -- it touches the shape of every response body -- so it should be adopted the
same way the request-ID field was, incrementally, rather than as a single cutover:

1. **Phase 1 -- additive fields only.** Attach the correlation ID on both transports (already done
   -- `request_id` on the Next.js body, `requestId` on the SSE error event; reconciling that
   camelCase/snake_case skew onto `request_id` is itself part of the additive rollout below) and
   introduce `meta` as an additive field on the existing Next.js error JSON body, without changing
   `error`/`name`/`request_id` at the top level. Existing clients parsing the current shape are
   unaffected; new clients can start reading `meta`.
2. **Phase 2 -- introduce the taxonomy fields additively.** Add `error.type` and `error.code` to
   both transports' error output without removing the current `error`/`message`/`name` fields.
   Clients that only read the old fields keep working; clients that want structured error handling
   can switch to `type`/`code`.
3. **Phase 3 -- adopt the full envelope for new endpoints/fields.** Any new public endpoint, and
   any existing endpoint gaining a new cross-transport field, is built directly on
   `ResponseEnvelope` + the two serializers instead of hand-rolling another one-off shape. Existing
   endpoints are migrated opportunistically, not as a forced big-bang rewrite.

This mirrors the request-ID rollout: add the new thing beside the old thing, let both exist until
the old shape is no longer load-bearing for any client, and only remove it if/when that is
verified.

### Trigger for phase 3 / real implementation

This doc is a design direction, not a commitment to build the envelope now. The concrete trigger
to start implementing it for real: **the next time a field needs to be added to both transports'
error or metadata output** (a plausible candidate is a `retry_after` field on rate-limit errors,
or a deprecation header/event). At that point, implement the field via the envelope + serializers
described here rather than adding a fourth divergent shape.

## Open questions

- **Package home for the serializers:** `@bike4mind/services` (recommended above) vs. a new
  `@bike4mind/transport` package. Revisit if the serializers grow beyond the two functions
  described here.
- **Docs-site build validation:** no `docusaurus.config.js` or `sidebars.*` was found under
  `docs-site/` in this repository at the time this doc was written, so this category was validated
  by matching the existing `docs-site/docs/admin/_category_.json` pattern and confirming
  well-formed JSON/frontmatter, not by a local docusaurus build.
