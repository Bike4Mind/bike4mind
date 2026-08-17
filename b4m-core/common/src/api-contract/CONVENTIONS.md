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
cannot be fixed without breaking live callers. Those declare
`conventionExemptions: { '<rule>': '<why>' }` on the contract.

There is exactly one legitimate reason to add an entry: **conforming would break a live
caller.** In practice that means a status code or a newly required scope, the two things
that cannot be aliased the way a URL or a wire field can. "It is easier this way" is not a
reason, and a new endpoint has no live callers to protect, so it never qualifies.

Every entry is debt with an owner. The list should only ever shrink, each removal behind
a published sunset. Grep `conventionExemptions` for the current set - today it is
`/api/ai/tts` only (`status-table`, `scope-required`).

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

> **Known divergence (not yet fixed).** `errorHandler.ts` adds an undocumented `name`
> field to every error body, so the runtime currently sends a superset of the documented
> envelope. Tracked separately; see [What is not gated yet](#what-is-not-gated-yet).

### Status codes for shared conditions

A condition maps to **one** status everywhere. Pick from this table rather than
re-deciding per endpoint:

| Condition | Status | `errorCode` |
|---|---|---|
| Malformed JSON body | `400` | - |
| Request body failed schema validation | `422` | - |
| Missing or invalid credential | `401` | - |
| Valid key, missing scope | `403` | - |
| Provider rejected *our* credentials | `401` | `provider_not_configured` |
| Provider failed to generate (upstream error) | `502` | - |
| No provider key configured for this deployment | `503` | - |
| Insufficient credits | `422` | `insufficient_credits` |
| Spend cap exceeded | `422` | `spend_cap_exceeded` |
| Rate limit exceeded | `429` | - |
| Response payload exceeds the platform ceiling | `413` | `response_too_large` |
| Referenced resource does not exist | `404` | - |

**[gated]** A contract may only declare statuses from the allowed set (`200`, `201`,
`202`, `204`, `400`, `401`, `403`, `404`, `409`, `413`, `422`, `429`, `500`, `502`,
`503`).

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
- `LEGACY_PUBLIC_PATHS` in `assertContractConventions.ts` is the baseline: the six
  already-published paths that predate this rule. **The list is frozen - entries are only
  ever removed.** Adding to it is the thing this convention exists to prevent.

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

Every response carries `X-Request-ID`. API-key-authenticated responses additionally carry
the six rate-limit headers set by `server/middlewares/apiKeyRateLimit.ts`:
`X-RateLimit-{Limit,Remaining,Reset}-{Minute,Day}`.

> **Known divergence (not yet fixed).** The spec publishes the unwindowed names
> (`X-RateLimit-Limit`/`-Remaining`/`-Reset`) and attaches them only to `executeTool`,
> while the runtime sets the six windowed names on *every* API-key-authenticated
> response. A client coding against the published names reads `undefined`. See
> [What is not gated yet](#what-is-not-gated-yet).

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
| Response headers match the middleware | Contracts do not declare headers yet. The published names are wrong today, so a diff gate would fail on arrival; the spec fix has to land first. |
| Error bodies carry no undocumented keys | `errorHandler.ts` adds `name` to every body, including internal routes. Removing it is a behavioural change well outside the contract layer. |
| Wire fields are `snake_case` | Requires walking Zod shapes, and today's schemas deliberately accept camelCase aliases, so the check would fail on arrival. Needs the alias metadata to exist first. |
| One `errorCode` vocabulary | The TTS codes are not in the shared union yet. |
| `202` + job resource for unbounded work | Not structurally detectable - it is a design review question. |
