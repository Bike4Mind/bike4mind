---
title: Building an app on Bike4Mind
description: Sign users in with Bike4Mind, bill AI usage to their own credits, and read their account state
sidebar_position: 1
content_type: ['conceptual', 'how-to']
audience: ['developers']
tags: [developers, oauth, oidc, api]
---

# Building an app on Bike4Mind

This guide is for developers building their own app on top of Bike4Mind (B4M). It assumes you have never seen the B4M codebase. By the end your app will:

- let users **sign in with B4M** (OpenID Connect, authorization code + PKCE),
- run AI completions **billed to the signed-in user's B4M credits**, not to you,
- detect when a user **runs out of credits**, and
- read the user's **plan and balance**.

Throughout, `https://<your-b4m-host>` is the B4M deployment you integrate with (hosted B4M or your own self-hosted instance) and `https://app.example.com` is your app.

This guide is about B4M acting as an identity provider _for your app_. If you want B4M itself to accept sign-ins from an enterprise IdP such as Okta, see [Identity Providers](../features/identity-providers.md) instead.

## 1. What B4M gives you

| Capability                 | How                                                                                  | Scope                      |
| -------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| Sign-in                    | OIDC authorization code + PKCE                                                       | `openid email profile`     |
| Per-user billing           | Exchange the user's ID token for a short-lived API key at `POST /api/oauth/ai-token` | `ai:generate`              |
| AI completions             | `POST /api/ai/v1/completions` (streamed)                                             | `ai:generate`              |
| Credit balance             | `GET /api/v1/credits`                                                                | `ai:generate` or `me:read` |
| User plan and entitlements | `GET /api/v1/me`                                                                     | `me:read`                  |

The full public API is described by the OpenAPI spec at `https://<your-b4m-host>/api/v1/openapi.json`, with an interactive reference at `https://<your-b4m-host>/api/v1/docs`. This guide covers the integration flow; use the reference for every endpoint's full request and response shape.

**Not yet available to third-party apps:** mementos (the user's saved memories) have no public API or scope yet. Do not build against them.

## 2. Choose your shape

The supported shape for a third-party app is an **external app on its own domain**, registered with B4M as a **confidential relying-party client**. Your app has a server that holds a client secret; the browser never sees it.

You do **not** need an intermediate identity provider (for example a hosted user pool sitting in front of B4M). B4M is itself the OIDC provider: your app signs users in against B4M directly and uses the ID token B4M issues.

Building a module that runs inside a B4M deployment is not a third-party option; this guide covers external apps only.

## 3. Sign in with B4M

### Discovery

Fetch the discovery document from `https://<your-b4m-host>/.well-known/openid-configuration`. It advertises:

| Field                                   | Value                         |
| --------------------------------------- | ----------------------------- |
| `issuer`                                | the B4M host URL              |
| `authorization_endpoint`                | `{issuer}/oauth/authorize`    |
| `token_endpoint`                        | `{issuer}/api/oauth/token`    |
| `userinfo_endpoint`                     | `{issuer}/api/oauth/userinfo` |
| `jwks_uri`                              | `{issuer}/api/oauth/jwks`     |
| `scopes_supported`                      | `openid`, `email`, `profile`  |
| `code_challenge_methods_supported`      | `S256`                        |
| `token_endpoint_auth_methods_supported` | `client_secret_post`, `none`  |
| `id_token_signing_alg_values_supported` | `RS256`                       |

Use `jwks_uri` exactly as published. `/.well-known/jwks.json` also answers today, but it is an alias, not the advertised URL. Both documents are cached for an hour, so cache them on your side too.

Discovery does not list the `ai:generate` and `me:read` scopes because they are not sign-in scopes, but you **must still request them in the authorization request** so the user consents to them. B4M records the scopes the user consented to, and the token exchange (section 5) can only mint scopes from that set.

### The authorization request

Use the authorization code flow with PKCE (`S256`), plus `state` and `nonce`. **Always send PKCE**, even though your client is confidential.

1. On your server, generate a random `state`, a random `nonce`, and a random `code_verifier`. Compute `code_challenge = BASE64URL(SHA256(code_verifier))`. Store all three in the user's pre-login session.
2. Redirect the browser to `authorization_endpoint` with: `client_id`, `redirect_uri`, `response_type=code`, `scope=openid email profile ai:generate`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`.
3. B4M signs the user in if needed. The first time a user signs in to your app, B4M shows a consent screen; the user's decision is remembered for your app, so later sign-ins redirect straight back. Send `prompt=consent` to show the screen again.
4. B4M redirects to your `redirect_uri` with `?code=...&state=...`. If the user denies consent, you get `?error=access_denied&state=...` instead. Other errors (an unknown client, a `redirect_uri` that is not registered, a scope your client is not allowed) are shown on the B4M page and **do not** redirect back to you.

`redirect_uri` must match one of your registered redirect URIs exactly.

Add `me:read` to `scope` if you will read the user's state (section 7). Request every API scope you will ever exchange for: a scope the user never consented to is rejected at the exchange, and the fix is to send the user through this request again with that scope included.

### The code exchange

On your callback, check that `state` matches the stored value, then POST to `token_endpoint` from your **server**, as a form or JSON body:

| Parameter       | Value                                                                   |
| --------------- | ----------------------------------------------------------------------- |
| `grant_type`    | `authorization_code` (the only grant this endpoint accepts)             |
| `code`          | from the callback                                                       |
| `redirect_uri`  | the same value as in the authorization request                          |
| `client_id`     | your client id                                                          |
| `client_secret` | your client secret (sent in the body; HTTP Basic auth is not supported) |
| `code_verifier` | the stored PKCE verifier                                                |

Codes live for 10 minutes and are single-use. The token endpoint allows 20 requests per minute. A wrong secret returns 401 `invalid_client`.

The response is `{ access_token, id_token, token_type: "Bearer", expires_in, scope }`. There is **no refresh token** for third-party apps.

### Verify the ID token

The ID token is an RS256 JWT with a `kid` header. Verify it before you trust it:

- the signature, against the keys at `jwks_uri`,
- `iss` equals the discovery `issuer`,
- `aud` equals your `client_id`,
- `exp` has not passed,
- `nonce` equals the value you stored.

Its claims are `sub` (the stable B4M user id), `iss`, `aud`, `iat`, `exp` and `nonce`, plus `email` with the `email` scope and `name` and `picture` with the `profile` scope. Key your own user records on `sub`.

**Keep the ID token on your server.** You need it again for the billing exchange in section 5.

### Sessions and lifetimes

Currently the access token lives 30 minutes and the ID token 1 hour; always trust `expires_in` and the token's `exp` rather than these numbers. Give the browser your own HttpOnly session cookie and keep every B4M token server-side.

Because there is no refresh token, when the ID token expires you send the user through `authorization_endpoint` again. A user who is still signed in to B4M and has already consented is redirected straight back with a new code, without seeing a B4M page.

The B4M access token is only good for `GET {issuer}/api/oauth/userinfo`, which returns `sub`, `email` and `email_verified` (email scope), and `name` and `picture` (profile scope). Every other B4M API rejects it. To call AI or account APIs, use the exchange in section 5.

The refresh-token endpoint and the device flow serve first-party B4M clients only (the B4M CLI and desktop app). They are not available to third-party apps.

Users can review and revoke the apps they have granted access to from their B4M account.

## 4. Register a client

Every app needs a registered OAuth client. A client record has:

| Field                     | Meaning                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `clientId`                | your public client id, generated at registration                                            |
| client secret             | generated at registration and shown once; B4M stores only a hash                            |
| `name`                    | your app's name, shown on the consent screen                                                |
| `redirectUris`            | the exact callback URLs B4M may redirect to                                                 |
| `allowedScopes`           | the scopes your client may request, including at the token exchange                         |
| `tokenEndpointAuthMethod` | `client_secret_post` (confidential) or `none` (public, PKCE only)                           |
| `clientType`              | `relying-party` for third-party apps: users see a consent screen and your tokens are scoped |
| `isActive`                | whether the client can be used                                                              |
| `federatedIdp`            | the trust config that enables the AI-token exchange (below)                                 |

The `federatedIdp` trust config for an app that signs in with B4M is:

| Field           | Value                                           |
| --------------- | ----------------------------------------------- |
| `subjectSource` | `sub` (the B4M user id is the ID token's `sub`) |
| `issuer`        | the B4M host URL (the discovery `issuer`)       |
| `audience`      | your `client_id`                                |
| `jwksUri`       | the published `jwks_uri`                        |

With that config, the client's `allowedScopes` are `openid email profile ai:generate me:read`.

### Self-hosted B4M

Operators register clients with the seed script, run from the repository root. One pass registers the client with its trust config:

```bash
MONGODB_URI="<mongodb-uri>" \
CLIENT_NAME="My App" \
REDIRECT_URIS="https://app.example.com/callback" \
FEDERATED_SUBJECT_SOURCE=sub \
FEDERATED_ISSUER="https://<your-b4m-host>" \
FEDERATED_JWKS_URI="https://<your-b4m-host>/api/oauth/jwks" \
  npx tsx packages/scripts/src/seed-oauth-client.ts
```

- `REDIRECT_URIS` is comma-separated.
- `FEDERATED_AUDIENCE` can be omitted with `FEDERATED_SUBJECT_SOURCE=sub`; it defaults to the generated `client_id`.
- `CLIENT_TYPE` defaults to `relying-party`. Leave it.
- The script prints the `client_id` (shaped `b4m_<name>_<hex>`) and the client secret **once**. Store the secret in your app's secret manager.
- The script is idempotent by name: if a client with that `CLIENT_NAME` exists, it changes nothing.
- It always creates a confidential client. That is what you want: the AI-token exchange requires a client secret.

Register the trust config in the same run. Adding `federatedIdp` to an existing client by hand leaves `allowedScopes` without `ai:generate` and `me:read`, and the exchange then fails with 403 `invalid_scope`.

There is no admin UI or API for registration yet.

### Hosted B4M

Registration on hosted B4M is done by the maintainers on request and is not self-serve yet. Open an issue on the [Bike4Mind GitHub repository](https://github.com/bike4mind/bike4mind/issues) with your app's name and redirect URIs, and never post a secret in the issue.

## 5. Bill the user, not yourself

To run AI on a user's behalf, your server exchanges that user's B4M ID token for a short-lived B4M API key that bills **the user's** credits.

### The exchange

`POST https://<your-b4m-host>/api/oauth/ai-token` with a JSON body:

| Field           | Value                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| `client_id`     | your client id                                                                        |
| `client_secret` | your client secret (always required, so call this from your server only)              |
| `id_token`      | the user's B4M ID token from sign-in                                                  |
| `scope`         | optional, space-separated from `ai:generate` and `me:read`; defaults to `ai:generate` |

Every requested scope must be in your client's `allowedScopes`, and the user must have consented to it in the authorization request (section 3). Hosted B4M enforces the consent check. On a self-hosted deployment it is warn-only unless the operator sets `OAUTH_AI_TOKEN_ENFORCE_GRANT=true`; set it, and do not rely on the lenient default.

A successful response is:

```json
{ "api_key": "b4m_live_...", "token_type": "ApiKey", "expires_in": 900, "scope": "ai:generate" }
```

The key currently lives 15 minutes; use `expires_in` rather than hard-coding 900. Send it as `Authorization: Bearer b4m_live_...` (the `x-api-key` header is accepted for older callers).

The ID token must still be valid when you exchange it. Once it expires, re-authorize the user (section 3) before you can mint another key. A 403 `access_denied` for missing consent also needs re-authorization, and only helps if the new authorization request includes the API scopes you exchange for.

| Response                      | Meaning                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 401 `invalid_client`          | unknown `client_id` or wrong secret                                                                                    |
| 403 `access_denied`           | the client has no trust config, the user has not consented to these scopes, or the user has not accepted the B4M terms |
| 403 `invalid_scope`           | a requested scope is not allowed for this client                                                                       |
| 401 `invalid_grant`           | the ID token is invalid or expired, or its subject is not a B4M user                                                   |
| 400 `invalid_request`         | the body is malformed, `scope` is empty, or the user has reached their cap on API keys                                 |
| 429                           | rate limited (300 per minute per client, and per IP); honour `Retry-After`                                             |
| 503 `temporarily_unavailable` | B4M could not check the user's consent; retry with backoff                                                             |

The per-client and per-IP limits return different 429 bodies, so branch on the status, not the `error` field.

### One live key per user: cache it in one place

Every successful exchange **revokes the previous key** minted for the same user and app. At most one key is live per (user, app) pair. That has consequences:

- Cache one key per user and reuse it until it is close to expiry. Do not mint per request.
- Keep that cache in **one place**, and let only one mint per user be in flight at a time. Two concurrent cold-cache requests in the same process otherwise each mint, and the second revokes the first. If two processes each mint for the same user, each mint revokes the other's key, the next request fails, both re-mint, and the loop never converges. A multi-instance deployment needs a shared cache (for example Redis) keyed by user id, or a single service that owns minting.
- Never "evict and retry" a rejected key across processes for the same reason.

### Safeguards

- **Expiry skew.** Re-mint shortly before `expires_in` runs out (for example 60 seconds early), not after a request fails.
- **Default lifetime.** If `expires_in` is ever missing, assume the 900-second default rather than caching forever.
- **Negative cache.** After a 401 or 403 from the exchange, remember the failure for that ID token briefly instead of retrying on every request. Either the user needs to sign in or consent again, or your client is misconfigured (`invalid_client`, `invalid_scope`); log the `error` code to tell which. After a 429 or 503, back off for `Retry-After` seconds when it is present.
- **Timeout.** Bound the exchange call with a timeout so a slow B4M does not hang your request path.
- **One re-mint.** If B4M rejects a cached key, mint once and retry once. If that fails too, surface the error.

Revoking your app's access in B4M stops new exchanges, but a key already minted stays valid until it expires (up to 15 minutes).

## 6. Handle "out of credits"

### Before you start

`GET https://<your-b4m-host>/api/v1/credits` with the user's `ai:generate` key returns `{ "balance": 31667 }`. Use it as a pre-flight check before a batch of work. A 401 means the key itself was rejected (see "One re-mint" above).

### During a completion

`POST /api/ai/v1/completions` always answers with a Server-Sent Events stream, and once the stream opens the HTTP status is **always 200**. Authentication failures, invalid requests and credit exhaustion all arrive as an in-band event:

```json
{ "type": "error", "message": "...", "requestId": "...", "code": "insufficient_credits" }
```

- `code: "insufficient_credits"`: the user is out of credits. Prompt them to top up their B4M balance.
- `code: "spend_cap_exceeded"`: reserved. The key hit an admin-set spending ceiling, so topping up does not help. Keys from the exchange do not carry a cap today, so you should not see it, but handle it defensively.
- `code` absent: an unclassified failure (including a rejected key). Show `message` and log `requestId`.

Text arrives as `content` events. With a reasoning model, the text can begin with a `<think>...</think>` span holding the model's reasoning; strip it before you show the reply to the user. The stream ends with `data: [DONE]`; if it ends without one, the reply is incomplete.

Branch on `code`, never on `message`, which is prose and can change. The HTTP status tells you nothing here, and the public API never returns 402. (The JSON, non-streaming B4M APIs report the same condition as HTTP 422 with `errorCode: "insufficient_credits"`.)

## 7. Read the user's state

Request `me:read` at the exchange (`scope: "ai:generate me:read"`) and call `GET https://<your-b4m-host>/api/v1/me`:

```json
{
  "id": "...",
  "name": "Ada Lovelace",
  "tier": "basic",
  "subscription": {
    "plan_name": "Professional",
    "price_id": "price_123",
    "interval": "monthly",
    "current_period_ends_at": "2026-10-18T00:00:00.000Z"
  },
  "credits": { "balance": 31667 },
  "entitlements": ["base"]
}
```

- `id` is the same stable B4M user id as the ID token's `sub`.
- `tier` is one of `free`, `basic`, `pro`, `other`. Use `tier != "free"` for "is this user paying" and `subscription?.price_id` for which product; tier names do not track a plan's marketing name.
- `subscription` is `null` when the user has none, and can also be `null` for a paying user (for example `tier: "other"`, a subscriber on a retired price). Do not treat `null` as "not paying".
- `credits.balance` is the user's personal balance, the same number as `GET /api/v1/credits`.

## 8. What not to do

- Never send the client secret or a minted `b4m_live_` key to the browser. Both stay on your server.
- Never put credentials in URLs, query strings or fragments.
- Never log a full key. Log its first few characters, or the `requestId`.
- Never pay for users' work with a single "house" API key of your own. Use the exchange so each user is billed for their own usage.
- Never match on error `message` text. Use `code` / `errorCode`.
- Never skip `state`, `nonce` or PKCE.

## 9. Worked example

A minimal server-side flow in TypeScript, using Node 18+ (`fetch`, `crypto`) and [`jose`](https://github.com/panva/jose) for ID-token verification. Session storage and the HTTP framework are left to you: `session` stands for your server-side session store.

### Setup

```ts
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const B4M = 'https://your-b4m-host';
const CLIENT_ID = process.env.B4M_CLIENT_ID!;
const CLIENT_SECRET = process.env.B4M_CLIENT_SECRET!; // server-side only
const REDIRECT_URI = 'https://app.example.com/callback';

const discovery = await fetch(`${B4M}/.well-known/openid-configuration`).then(r => r.json());
const JWKS = createRemoteJWKSet(new URL(discovery.jwks_uri));

const b64url = (buf: Buffer) => buf.toString('base64url');
```

### Login: redirect to B4M with PKCE

```ts
function login(session: Record<string, string>): string {
  const state = b64url(crypto.randomBytes(16));
  const nonce = b64url(crypto.randomBytes(16));
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  Object.assign(session, { state, nonce, codeVerifier });

  const url = new URL(discovery.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile ai:generate',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString(); // redirect the browser here
}
```

### Callback: exchange the code and verify the ID token

```ts
async function callback(session: Record<string, string>, query: URLSearchParams) {
  if (query.get('error')) throw new Error(`Sign-in failed: ${query.get('error')}`);
  if (!query.get('state') || query.get('state') !== session.state) throw new Error('State mismatch');

  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: query.get('code')!,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: session.codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const { id_token } = await res.json();

  const { payload } = await jwtVerify(id_token, JWKS, { issuer: discovery.issuer, audience: CLIENT_ID });
  if (payload.nonce !== session.nonce) throw new Error('Nonce mismatch');

  // Keep the ID token server-side; it is needed for the billing exchange.
  return { userId: payload.sub!, idToken: id_token };
}
```

### A per-user key cache

```ts
type CachedKey = { key: string; expiresAt: number };
const keys = new Map<string, CachedKey>();
const inFlight = new Map<string, Promise<string>>(); // userId -> the mint in progress
// Keyed by ID token, so a fresh sign-in is not blocked by a failure on the old token.
const failures = new Map<string, number>(); // idToken -> retry-after timestamp

const SKEW_MS = 60_000;
const DEFAULT_TTL_S = 900;
const NEGATIVE_TTL_MS = 60_000;

// Every mint revokes the user's previous key, so mint at most once at a time per user:
// concurrent callers share the in-flight mint. With several instances, move both maps
// to a shared store keyed by userId, or two minting processes fight.
async function getUserKey(userId: string, idToken: string, { force = false } = {}): Promise<string> {
  const cached = keys.get(userId);
  if (!force && cached && cached.expiresAt - SKEW_MS > Date.now()) return cached.key;
  const pending = inFlight.get(userId);
  if (pending) return pending;

  const mint = mintKey(userId, idToken).finally(() => inFlight.delete(userId));
  inFlight.set(userId, mint);
  return mint;
}

async function mintKey(userId: string, idToken: string): Promise<string> {
  const failedUntil = failures.get(idToken);
  if (failedUntil !== undefined) {
    if (failedUntil > Date.now()) throw new Error('Exchange recently failed; retry later or re-authorize the user');
    failures.delete(idToken);
  }

  const res = await fetch(`${B4M}/api/oauth/ai-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      id_token: idToken,
      scope: 'ai:generate',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) {
    failures.set(idToken, Date.now() + NEGATIVE_TTL_MS);
    keys.delete(userId);
  } else if (res.status === 429 || res.status === 503) {
    const retryAfterS = Number(res.headers.get('Retry-After')) || NEGATIVE_TTL_MS / 1000;
    failures.set(idToken, Date.now() + retryAfterS * 1000);
  }
  if (!res.ok) throw new Error(`ai-token exchange failed: ${res.status}`);

  const body = await res.json();
  const ttlSeconds = body.expires_in ?? DEFAULT_TTL_S;
  keys.set(userId, { key: body.api_key, expiresAt: Date.now() + ttlSeconds * 1000 });
  return body.api_key;
}
```

### A streamed completion that handles "out of credits"

```ts
class OutOfCreditsError extends Error {}
class SpendCapError extends Error {}

async function checkBalance(key: string): Promise<Response> {
  return fetch(`${B4M}/api/v1/credits`, { headers: { Authorization: `Bearer ${key}` } });
}

async function complete(userId: string, idToken: string, prompt: string): Promise<string> {
  let key = await getUserKey(userId, idToken);

  // Pre-flight: a 401 here means the cached key was rejected. Re-mint exactly once.
  let pre = await checkBalance(key);
  if (pre.status === 401) {
    key = await getUserKey(userId, idToken, { force: true });
    pre = await checkBalance(key);
  }
  if (!pre.ok) throw new Error(`Balance check failed: ${pre.status}`);
  const { balance } = await pre.json();
  if (balance <= 0) throw new OutOfCreditsError('User has no B4M credits');

  const res = await fetch(`${B4M}/api/ai/v1/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-8', // pick a model from the API reference
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Completion request failed: ${res.status}`);

  // The status is 200 even on failure; read the events.
  let text = '';
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      // Reasoning models prefix their reasoning in a <think> span; never show it to users.
      if (data === '[DONE]') return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      const event = JSON.parse(data);
      if (event.type === 'error') {
        if (event.code === 'insufficient_credits') throw new OutOfCreditsError(event.message);
        if (event.code === 'spend_cap_exceeded') throw new SpendCapError(event.message);
        throw new Error(`Completion failed (requestId ${event.requestId}): ${event.message}`);
      }
      if (event.type === 'content') text += event.text;
    }
  }
  throw new Error('Completion stream ended without [DONE]');
}
```

Catch `OutOfCreditsError` in your UI and send the user to top up their B4M balance. On `SpendCapError`, tell them a B4M spending cap was reached (topping up will not help).

## Further reading

- The API reference: `https://<your-b4m-host>/api/v1/docs` (spec at `/api/v1/openapi.json`).
- [Federated AI-token exchange](https://github.com/bike4mind/bike4mind/blob/main/docs/architecture/federated-ai-token-exchange.md): the server-side design of the exchange endpoint.
