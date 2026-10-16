---
title: Scoped usage export
description: Pull fixed-scope daily accounting snapshots for Fleet.
---

## Configuration

`GET /api/usage/fleet-export?from=YYYY-MM-DD&to=YYYY-MM-DD` is a dedicated server-to-server integration, not a general public API-key endpoint. It accepts only `Authorization: Bearer <export-token>`. Browser sessions, platform-admin sessions, and ordinary API keys do not authorize this export. It is deliberately outside the general API-key contract registry.

Configure these server-only environment values on the API runtime:

- `FLEET_USAGE_EXPORT_TOKEN`: a dedicated, randomly generated credential of at least 32 characters. Store it only in the two servers' secret stores. Never use a platform-admin credential.
- `FLEET_USAGE_EXPORT_SCOPE`: JSON with `userIds` (1-1000 explicit actor account IDs) and `owners` (1-100 explicit `{ownerId,ownerType}` billing scopes). Owner type is `User`, `Organization`, or `Agent`. Both lists are required and nonempty. No default scope is provided. Rotate/revoke by updating the runtime configuration.

The database read requires both an allowed actor and an allowed billing owner pair. The caller cannot select a company, actor, owner, or source. Missing, empty, or malformed configuration denies access. Scope changes require the runtime environment to be refreshed; provisioning and deployment are separate from this implementation.

## Snapshot semantics

The shared runtime schema is `b4m-core/common/src/schemas/fleetUsageExport.ts`. Version 1 uses camelCase for this dedicated integration. Dates are inclusive UTC calendar dates, at most 31 days. Every requested day is present, even when its `rows` is empty. Consumers replace each day's previous snapshot, never add it to the previous pull. A repeated pull has the same accounting rows unless underlying records/accounts changed; `generatedAt` changes. Repull recent days for late settlements. There is no historical relabel or source backfill.

Rows group by date, actual `userId`, billing `ownerId`/`ownerType`, provider, exact model, settlement basis, source, and status. Email is resolved from the actor's current account record and is null if unavailable or malformed. Owner identity is never substituted for the actor. Sources are `desktop`, `cli`, `api`, `web`, `agent`, `system`, and `unclassified`. Missing settlement basis is `unclassified`, not an invented local/provider classification.

`inputTokens`/`outputTokens` retain local estimates. `providerInputTokens`/`providerOutputTokens` retain provider counts, independently null if any event in the group lacks that axis. `cacheReadTokens` and `cacheWriteTokens` are inclusive cache counters, never added to input. `costUsd` is frozen provider COGS, not credits. `creditsCharged` and `writtenOffCredits` remain separate, with collected credits equal to charged minus written off. Statuses (`ok`, `error`, `timeout`, `refusal`, `degenerate`) stay separate; failed rows keep their recorded cost and credits. `requests` counts UsageEvent records, not user turns or HTTP requests.

Only recorded backend UsageEvents are covered. Local Desktop provider calls, local tools, and Desktop OpenTelemetry are not covered. The Desktop AuthService sends `User-Agent` and `X-B4M-Client` as `b4m-desktop/<version>`. New backend calls carrying that signal are classified as Desktop. The header is attribution, never authorization.

All counters must be finite, nonnegative, and no larger than JavaScript's maximum safe integer. An invalid accounting record fails the pull rather than being silently dropped. Limits are 100,000 underlying events, 10,000 grouped rows, and 4 MB per response. Oversized pulls fail without truncation; request a smaller range. Success is 200, invalid credentials/configuration 401, invalid query 422, unsupported method 405, oversized response 413, and unavailable export 500. Errors use `{error,request_id}`. Every response has `X-Request-ID` and `Cache-Control: no-store`.

Access allows, denials, and invalid queries persist in the existing CounterLog collection as `Fleet Usage Export Access`, with a service principal, outcome, request ID, and validated range only. Successful exports require a durable audit write before release. Audit failure prevents release and emits a request-ID-only server error. No token, content, prompts, tool arguments, repository paths, session IDs, or account lists are in this audit payload. CounterLog has no TTL in its schema; actual database retention/access-log policy and deployed allow/deny checks must be verified by the operator.
