# Federated AI-token exchange

`POST /api/oauth/ai-token` lets a registered OAuth client trade an ID token for its
logged-in user against a short-lived, revocable API key scoped to that user.
The default scope is `ai:generate`. The app then calls `/api/ai/v1/completions` with the key as `X-API-Key`, so
completions bill the user's own B4M credits ("user-pays") with no manual key paste.

Only a client whose registration carries a `federatedIdp` trust config may use the
exchange. Everything else about the endpoint (consent gate, per-client rate limit,
reuse-or-replace of the prior key, mint audit entry) is common to every client.

## Requesting scopes

Send `client_id`, `client_secret`, and `id_token` in the POST body. The optional
`scope` field is a space-separated list; omitting it defaults to `ai:generate`.
This exchange supports only `ai:generate` and `me:read`, individually or together:

```json
{
  "client_id": "<registered client id>",
  "client_secret": "<client secret>",
  "id_token": "<user ID token>",
  "scope": "ai:generate me:read"
}
```

Every requested scope must also appear in the client's `allowedScopes`. OIDC
scopes (`openid`, `email`, `profile`) and other API-key scopes are not supported
here, even if registered. Empty or whitespace-only scope strings are rejected.
Scope validation runs before revoking the previous exchange key. A successful
exchange replaces the previous key for that user/client pair, including when the
requested scopes differ, and returns the minted scopes in the response's `scope`.

## Grant enforcement and rollout

The SST `production` and `dev` stages enforce grants automatically. Other stages
use grace mode unless `OAUTH_AI_TOKEN_ENFORCE_GRANT=true`; in grace mode missing
grants or scope gaps produce warnings rather than rejection. Setting
`OAUTH_AI_TOKEN_ENFORCE_GRANT=false` (or any value other than `true`) overrides
the stage default and disables enforcement, including on `production` and `dev`.

In enforcement mode, relying-party clients need a durable OAuth grant for the
user/client pair, and the grant must cover every scope the exchange mints. An
identity-only grant (`openid/email/profile`) does not authorize any API-key scope.
First-party clients are exempt from the grant check;
client registration and policy acceptance checks still apply.

Before deployment, verify existing client registrations contain their requested
API-key scopes. Newly seeded federated clients include both supported scopes;
re-running the seed script does not update an existing registration. Check grace
warnings for relying parties that need re-authorization before enabling enforcement.

For `access_denied` due to missing grants or AI consent, send the user through the
OAuth authorization flow requesting the needed scope. Refreshing or re-exchanging
an ID token does not create a grant. A grant lookup failure returns 503 in
enforcement mode; retry after the underlying service recovers.

## The two issuer shapes

The client's `federatedIdp.subjectSource` decides how the presented token is verified.

|                        | `'identities'` (default)                                     | `'sub'`                                     |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| Who signed the token   | the app's own AWS Cognito pool, which federates B4M upstream | B4M's OIDC provider                         |
| `issuer`               | `https://cognito-idp.<region>.amazonaws.com/<poolId>`        | B4M's `APP_URL`                             |
| `audience`             | the Cognito app-client id                                    | the B4M `client_id` the token was issued to |
| `jwksUri`              | optional; defaults to `${issuer}/.well-known/jwks.json`      | **required, stated explicitly**             |
| `providerName`         | required; names the `identities[]` entry to read             | unused                                      |
| `token_use`            | must be `id`                                                 | absent; not asserted                        |
| B4M user id comes from | `identities[].userId` of the matching provider               | `sub`                                       |

An app is on the `'sub'` row when it signs users in directly against B4M rather than
standing up a Cognito pool in front of it. `subjectSource` is absent (`'identities'`)
by default, which is what keeps every already-registered client on its existing code
path; the field is set explicitly at registration time, not inferred from the token.

Both shapes verify through `aws-jwt-verify`, which checks the RS256 signature against
the JWKS and asserts `iss`, `aud`, `exp` and `iat`. That is also what rejects a B4M
_access_ token presented in place of an ID token: access tokens are HS256 session JWTs
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
FEDERATED_SUBJECT_SOURCE=sub \
FEDERATED_ISSUER="https://<b4m-app-url>" \
FEDERATED_AUDIENCE="<the client_id the script prints>" \
FEDERATED_JWKS_URI="https://<b4m-app-url>/api/oauth/jwks" \
  npx tsx packages/scripts/src/seed-oauth-client.ts
```

`FEDERATED_AUDIENCE` is the `client_id` B4M mints for the app, so this is a two-pass
registration: seed without the federated env vars to obtain the id, then update the
document with the trust config. For an external Cognito pool, omit
`FEDERATED_SUBJECT_SOURCE` (defaults to `'identities'`), set `FEDERATED_PROVIDER_NAME`
instead, and leave `FEDERATED_JWKS_URI` unset.

## Failure modes

| Condition                                                                                                                                                                                                                         | Response                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| unknown client or bad `client_secret`                                                                                                                                                                                             | 401 `invalid_client`          |
| client has no `federatedIdp`                                                                                                                                                                                                      | 403 `access_denied`           |
| empty, whitespace-only, or non-string `scope`                                                                                                                                                                                     | 400 `invalid_request`         |
| scope unsupported by the exchange or absent from the client's registration                                                                                                                                                        | 403 `invalid_scope`           |
| relying-party grant missing, or requested `ai:generate` not consented (enforcement mode)                                                                                                                                          | 403 `access_denied`           |
| grant lookup fails (enforcement mode)                                                                                                                                                                                             | 503 `temporarily_unavailable` |
| per-client mint budget exhausted                                                                                                                                                                                                  | 429 `temporarily_unavailable` |
| wrong issuer, wrong audience, expired, bad signature, access token in place of an ID token, non-`id` `token_use` on an `'identities'` config, a `'sub'` config without `jwksUri`, an `'identities'` config without `providerName` | 401 `invalid_grant`           |
| subject resolves to no B4M user                                                                                                                                                                                                   | 401 `invalid_grant`           |
| user has not accepted the AUP/ToS                                                                                                                                                                                                 | 403 `access_denied`           |
