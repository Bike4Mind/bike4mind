# Public API conventions

The rules a **public** endpoint must follow. The [README](./README.md) covers *how* to
build a contract; this file covers *what the contract must say* so the published surface
is consistent across endpoints rather than per-endpoint improvisation.

**Public** means API-key-callable: it appears in `CONTRACTS`, is registered into the
OpenAPI spec, and someone outside the SPA can call it. Internal SPA-backend routes under
`pages/api/*` are out of scope and stay plain handlers.

Anything marked **[gated]** is asserted structurally by
`assertContractConventions.ts`, which runs at spec-generation time - a violation fails
the build, not review. Everything else is a review rule, and the gaps are listed under
[What is not gated yet](#what-is-not-gated-yet) rather than left implicit.

## Exemptions

This gate was added to an already-published surface, so a few endpoints violate it and
cannot be fixed without breaking live callers. Those declare `conventionExemptions` on the
contract, carrying the reason:

```ts
conventionExemptions: {
  'status-table': { 402: 'Insufficient credits is 402 here and 422 everywhere else.' },
  'scope-required': 'Gating it now would 403 keys that work today.',
}
```

**`status-table` is keyed by the individual status**, not granted contract-wide, so
excusing `402` does not also wave through an unrelated `418` on the same endpoint. The
other two rules are contract-wide because that is genuinely their scope.

There is no `error-envelope` exemption: `bespokeErrorShape` already excuses that rule
per-response, which is strictly finer-grained than a contract-wide flag would be.

There is exactly one legitimate reason to add an entry: **conforming would break a live
caller.** In practice that means a status code or a newly required scope, the two things
that cannot be aliased the way a URL or a wire field can. "It is easier this way" is not a
reason, and a new endpoint has no live callers to protect, so it never qualifies. An empty
reason is not an exemption - the gate ignores it and still fails.

Every entry is debt with an owner. The list should only ever shrink, each removal behind
a published sunset. Grep `conventionExemptions` for the current set - today it is
`/api/ai/tts` only (`402`, `scope-required`).

---

## 1. Error model

### One envelope

Every JSON error body on a public endpoint is `ApiErrorSchema`
(`src/schemas/chat.ts`), published as the shared `ErrorResponse` component:

```jsonc
{
  "error": "Human-readable message.",   // required
  "request_id": "abc-123"               // optional, mirrors X-Request-ID
}
```

**[gated]** Every `>= 400` JSON response a contract declares must **carry** that envelope:
a required `error` string, with `request_id` optional if present.

**Extending it is the point.** Endpoint-specific detail belongs in a *typed member*
alongside `error` - `InsufficientCreditsErrorSchema` adds `errorCode`,
`ttsErrorResponseSchema` adds `provider` - never as an untyped bag of ad-hoc top-level
keys. The gate checks the envelope structurally rather than by identity with
`ApiErrorSchema`, precisely so the extensions we ask for keep passing.

A response with no JSON body at all (raw audio bytes, where `schema` is omitted) has no
envelope to carry, and is not checked.

An endpoint that genuinely cannot conform declares `bespokeErrorShape: '<reason>'` on that
response - a greppable escape hatch with a written reason, not a way to skip the rule
quietly. The only current use is `executeTool`'s 500, where a tool that ran but failed
returns the full `ToolExecutionResponse` (`success: false`).

**On the `name` field.** `apps/client/server/middlewares/errorHandler.ts` adds `name` -
the thrower's error *class* (`NotFoundError`, `UnprocessableEntityError`) - to every error
body it serves, which is every route, not just the contracted ones. That is an internal
implementation detail on a public wire, and it is going away.

It is **deprecated, sunset 2026-12-01**, and documented in the envelope until then.
Neither of the two obvious moves is right on its own:

- Removing it outright today would be a silent removal, which section 7 forbids -
  "undocumented legacy routes still count as published if they are reachable", and the
  same reasoning covers a reachable field. An audit found no consumer in `apps/client`,
  `packages/cli` (`extractServerMessage` reads `error` then `message`), the premium
  overlays, or the generated client - which was never going to carry it, since
  `ErrorResponse` never declared it. External callers cannot be audited from here, so the
  window exists for them.
- Documenting it *permanently* would be worse than either: it promotes a class name we
  rename at will into public API we then owe compatibility on. So it carries
  `deprecated: true` and a sunset in its description, not a plain field entry.

Deprecate-then-remove is the combination that works: the envelope is honest **now**, and
the field still leaves. Branch on the HTTP status, not on `name`. On the sunset date drop
it from `errorHandler.ts`, `ApiErrorSchema`, and `ErrorResponse` together.

Note that this reaches past contracts that name `ApiErrorSchema` directly. `errorHandler`
serves every *thrown* error body regardless of which schema the contract declared for that
status, so a bespoke error schema (`InsufficientCreditsErrorSchema`,
`ttsErrorResponseSchema`) would omit a field the wire carries. Those derive from
`ApiErrorSchema` via `.extend()` rather than re-declaring `error`/`request_id`, which is
also what makes the sunset a single edit. Write a bespoke error schema from scratch only
when the body is `res.status(...).json(...)`-ed rather than thrown and so never passes
through the middleware - `ttsResponseTooLargeSchema` is the one such case, and says so.

**[gated]** Now that the runtime and the spec agree, the middleware is pinned to the
envelope: `errorHandler.test.ts` asserts every key `errorHandler` adds is one
`ApiErrorSchema` declares - across all three of its branches, including the `HTTPError`
one that spreads `additionalInfo` (the endpoint's own typed members are excluded by key,
since those are its contract's concern). So a new undocumented field fails CI, and it
fails again if `name` is dropped from only some of the three places above. `ApiErrorSchema`
is the plain twin of `ErrorResponse` (the OpenAPI layer is generate-time only, so
`apps/client` cannot import the component); `openapi/errorEnvelopeParity.test.ts` keeps the
two copies from drifting, and pins `name`'s published `deprecated: true` and sunset date so
the deprecation cannot quietly decay into a plain documented field.

### Status codes for shared conditions

A condition maps to **one** status everywhere. Pick from this table rather than
re-deciding per endpoint:

| Condition | Status | `errorCode` |
|---|---|---|
| Malformed JSON body | `400` | - |
| Request body failed schema validation | `422` | - |
| Missing or invalid credential | `401` | - |
| Valid key, missing scope | `403` | - |
| Provider rejected *our* credentials | `401` | `provider_rejected` |
| Provider failed to generate (upstream error) | `502` | - |
| No provider key configured for this deployment | `503` | `provider_not_configured` |
| Insufficient credits | `422` | `insufficient_credits` |
| Spend cap exceeded | `422` | `spend_cap_exceeded` |
| Rate limit exceeded | `429` | - |
| Response payload exceeds the platform ceiling | `413` | `response_too_large` |
| Referenced resource does not exist | `404` | - |

**[gated]** A contract may only declare statuses from the allowed set (`200`, `201`,
`202`, `204`, `400`, `401`, `403`, `404`, `409`, `413`, `422`, `429`, `500`, `502`,
`503`).

The gate checks only that a status is **in the set**, not that a given *condition* maps
to the status this table says. That half is review-only - see
[What is not gated yet](#what-is-not-gated-yet). `/api/ai/tts` diverges today: it returns
`401` with `provider_not_configured` for "no usable key is configured"
(`pages/api/ai/tts.ts`), where this table says `503`.

The two provider classifiers are easy to invert, so to be explicit:
`provider_not_configured` means **we** have no usable key for that provider;
`provider_rejected` means the provider **refused** the key we sent.

**On 402 vs 422 for credits.** `402 Payment Required` is the more literal reading, and
`/api/ai/tts` uses it. We standardise on `422` anyway, because the
`insufficient_credits` / `spend_cap_exceeded` classifier vocabulary already rides on
`422` across chat, `/api/ai/music` and `/api/ai/sound-effects`
(`src/insufficientCredits.ts`), and RFC 9110 still reserves `402`. TTS is the lone
outlier, and it carries a `status-table` exemption rather than a silent pass.

`402` stays out of the allowed set so a *new* endpoint choosing it fails the build. TTS
keeps it until a sunset is published: a status code cannot be aliased the way a URL or a
field can, so `402 -> 422` breaks live callers.

### One error-code vocabulary

Where an error carries a machine-readable classifier it is the field `errorCode`, and its
value comes from **one** enumerated union - not a per-endpoint string union that happens
to share a field name. Today that union is `QUEST_ERROR_CODES`
(`src/types/entities/SessionTypes.ts`); TTS's `provider_not_configured` /
`provider_rejected` are a second, parallel vocabulary that needs folding in.

Adding a classifier means adding it to the shared union, not inventing a local one.

### Why RFC 9457 is not the answer here

The obvious alternative is `application/problem+json` (RFC 9457): standard, and
generators understand it. We are keeping the bespoke envelope because `error` +
`request_id` is already the published shape across every documented operation and every
generated client, and switching media type plus field names (`error` -> `detail`,
`errorCode` -> `type`) breaks every existing caller for no behavioural gain. The
consistency win this issue is after comes from having *one* envelope, which the gate now
enforces - not from which envelope it is. Revisit only at a major version.

---

## 2. Naming

- **Wire fields are `snake_case`.** This is what the published surface already leans on
  (`request_id`, `max_tokens`, `poll_url`, `message_received`) and what the
  OpenAI-compatible completions endpoint requires.
- **`operationId` is camelCase** **[gated]** and stable (review-only - a rename is
  indistinguishable from a new endpoint to the gate). It becomes the SDK method name, so
  treat it as public contract.
- Existing camelCase wire fields (`maxTokens`, `maxOutputTokens`, `executionTimeMs`,
  `fabFileId`, `errorCode`) are **deprecated aliases**, not errors. They keep working.

**Alias policy.** A field is never renamed in place. The new spelling is added, both are
accepted, the old one is marked deprecated in the schema with a stated sunset, and it
keeps being accepted until that date passes. Responses continue to emit *both* spellings
for the whole window. Removing an alias is a major-version change.

---

## 3. Versioning

- **One root: `/api/v1`.** New public endpoints live under `/api/v1/*`. **[gated]**
- Forward-only: a live URL is never renamed or removed. A new shape gets a new path; the
  old path stays and keeps working.
- The other roots in the tree (`/api/ai/v1`, `/api/voice/v2`, `/api/overwatch/v1`) are
  frozen, as is unversioned `/api/*`. They keep serving; nothing new is added to them.
- `LEGACY_PUBLIC_PATHS` in `assertContractConventions.ts` is the baseline: the seven paths
  already shipped in `apps/client/public/openapi.json` when this rule landed. **The list is
  frozen - entries are only ever removed.** Adding to it is the thing this convention
  exists to prevent.

---

## 4. Long-running work

Lambda caps a response at ~6MB and the proxy integration base64-wraps the body, so any
endpoint returning generated bytes inline eventually hits a ceiling it cannot control
(`server/utils/ttsResponseLimit.ts` turns that into a `413`). That is a platform
constraint, so it gets one platform answer rather than three per-endpoint ones.

**The pattern:** anything whose output is not *provably* bounded returns `202` plus a job
resource the caller polls. A synchronous byte-returning endpoint is allowed only where
the payload has a hard, documented upper bound.

Today there are three shapes for this - chat quest-polling (with an inline `wait: true`
escape), image-generation quest-polling, and fully synchronous audio. Converging them is
follow-up work; new endpoints use `202` + job resource.

---

## 5. Scopes

**[gated]** Every `apiKeyOrJwt` contract declares at least one scope. Scope semantics are
OR: a key needs any one of the listed scopes.

**[gated]** A `jwtOnly` or `public` contract declares **no** scopes - they are not
enforced for those auth modes, and declaring them would publish an
`x-required-scopes` that nothing checks.

Scope-less must be a decision, not an omission. `/api/ai/tts` requires no scope while
`/api/ai/music` and `/api/ai/sound-effects` require `ai:generate` - a gap that is an
accident of what each route shipped with, not a design. Closing it 403s keys that work
today, so TTS carries a `scope-required` exemption stating exactly that, and closing it
needs the same sunset treatment as any other breaking change.

---

## 6. Response headers

Every response carries `X-Request-ID`. Responses from an endpoint served by `baseApi`
additionally carry the six rate-limit headers set by
`server/middlewares/apiKeyRateLimit.ts` -
`X-RateLimit-{Limit,Remaining,Reset}-{Minute,Day}` - on API-key-authenticated requests.
Reset values are Unix epoch **seconds**.

**A contract declares whether it emits them**, via `emitsRateLimitHeaders: true`. This is
declared, not inferred, because reaching that middleware is a transport fact the contract
cannot derive: the Lambda adapter sets no rate-limit headers, and the Fargate SSE route
computes them and then discards them (`sseRoute.ts`). Set the flag if and only if the
handler mounts `baseApi`.

One exception to "every response of a flagged endpoint": the `401`/`403` that
`registerContract` auto-injects for an authenticated route. Those mean `apiKeyAuth`
rejected the credential, and `apiKeyRateLimit` is mounted after it, so it never ran. A
`401`/`403` a **contract declares itself** is a different failure - thrown from the
handler, after the middleware set all six - and does carry them. So the exclusion keys off
who declared the status, not off the status number.

There is no unwindowed `X-RateLimit-Limit`/`-Remaining`/`-Reset`. A client reading those
names gets `undefined`.

---

## 7. Deprecation

Nothing published is ever silently removed. Deprecating anything - a field, an alias, a
whole endpoint - means: mark it deprecated in the contract, state a sunset date in the
description, keep serving it until that date, and announce it before the date rather
than after.

Undocumented legacy routes still count as published if they are reachable.
`/api/ai/text-to-speech` and `/api/elabs/text-to-speech` both serve TTS today with no
contract and no stated deprecation; they need one before they can go.

---

## What is not gated yet

Honest list of the rules above that a reviewer still has to catch by hand, so nobody
mistakes "CI passed" for "conventions met":

| Rule | Why it is not gated |
|---|---|
| A condition maps to the status this guide gives it | The gate checks only that a status is in the allowed *set*. Nothing checks that "no provider key configured" is the `503` the table says - and `/api/ai/tts` returns `401` for it today. Not structurally derivable: the condition lives in handler control flow, not the contract. |
| `emitsRateLimitHeaders` matches the handler's middleware chain | Half of this **is** now gated - the flag is rejected on any auth mode but `apiKeyOrJwt`, since `baseApi` mounts `apiKeyRateLimit` only on the api-key chain. What remains ungated is whether an `apiKeyOrJwt` handler actually mounts `baseApi`. Closing it needs the adapters to assert at runtime in non-prod, the way they already assert response schemas. |
| Wire fields are `snake_case` | Requires walking Zod shapes, and today's schemas deliberately accept camelCase aliases, so the check would fail on arrival. Needs the alias metadata to exist first. |
| One `errorCode` vocabulary | The TTS codes are not in the shared union yet. |
| `202` + job resource for unbounded work | Not structurally detectable - it is a design review question. |
