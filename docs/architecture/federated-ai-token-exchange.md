# Federated AI-token exchange

`POST /api/oauth/ai-token` lets a registered OAuth client trade an ID token for its
logged-in user against a short-lived, revocable `ai:generate` API key scoped to that
user. The app then calls `/api/ai/v1/completions` with the key as `X-API-Key`, so
completions bill the user's own B4M credits ("user-pays") with no manual key paste.

Only a client whose registration carries a `federatedIdp` trust config may use the
exchange. Everything else about the endpoint (consent gate, per-client rate limit,
reuse-or-replace of the prior key, mint audit entry) is common to every client.

## The two issuer shapes

The `federatedIdp.issuer` decides how the presented token is verified.

| | External IdP | B4M as issuer |
|---|---|---|
| Who signed the token | the app's own AWS Cognito pool, which federates B4M upstream | B4M's OIDC provider |
| `issuer` | `https://cognito-idp.<region>.amazonaws.com/<poolId>` | B4M's `APP_URL` |
| `audience` | the Cognito app-client id | the B4M `client_id` the token was issued to |
| `jwksUri` | optional; defaults to `${issuer}/.well-known/jwks.json` | **required, stated explicitly** |
| `providerName` | required; names the `identities[]` entry to read | unused |
| `token_use` | must be `id` | absent; not asserted |
| B4M user id comes from | `identities[].userId` of the matching provider | `sub` |

An app is on the second row when it signs users in directly against B4M rather than
standing up a Cognito pool in front of it. The discriminator is the issuer matching
B4M's own, not a config flag, so a client cannot opt a foreign issuer into the
sub-reading claim shape.

Both shapes verify through `aws-jwt-verify`, which checks the RS256 signature against
the JWKS and asserts `iss`, `aud`, `exp` and `iat`. That is also what rejects a B4M
*access* token presented in place of an ID token: access tokens are HS256 session JWTs
with no corresponding JWKS key.

Implementation: `apps/client/server/auth/verifyFederatedIdToken.ts`.

## JWKS URI

B4M's canonical JWKS endpoint is:

```
https://<b4m-app-url>/api/oauth/jwks
```

`/.well-known/jwks.json` is a rewrite alias for it, and the discovery document at
`/.well-known/openid-configuration` publishes the canonical form in `jwks_uri`. A
B4M-issued trust config must set `jwksUri` to that value rather than leave it to be
derived: the derivation rule belongs to Cognito's URL layout, and a config that relies
on it would break if the alias ever moved.

## Registering a client

`packages/scripts/src/seed-oauth-client.ts` registers a client and prints its
`client_id` / `client_secret`. For a B4M-issued client:

```bash
MONGODB_URI=<uri> \
CLIENT_NAME=<name> \
REDIRECT_URIS="https://..." \
FEDERATED_ISSUER="https://<b4m-app-url>" \
FEDERATED_AUDIENCE="<the client_id the script prints>" \
FEDERATED_JWKS_URI="https://<b4m-app-url>/api/oauth/jwks" \
  npx tsx packages/scripts/src/seed-oauth-client.ts
```

`FEDERATED_AUDIENCE` is the `client_id` B4M mints for the app, so this is a two-pass
registration: seed without the federated env vars to obtain the id, then update the
document with the trust config. For an external Cognito pool, set
`FEDERATED_PROVIDER_NAME` instead and leave `FEDERATED_JWKS_URI` unset.

## Failure modes

| Condition | Response |
|---|---|
| unknown client or bad `client_secret` | 401 `invalid_client` |
| client has no `federatedIdp` | 403 `access_denied` |
| per-client mint budget exhausted | 429 `temporarily_unavailable` |
| wrong issuer, wrong audience, expired, bad signature, access token in place of an ID token, B4M-issued config without `jwksUri`, external config without `providerName` | 401 `invalid_grant` |
| subject resolves to no B4M user | 401 `invalid_grant` |
| user has not accepted the AUP/ToS | 403 `access_denied` |
