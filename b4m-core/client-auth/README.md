# @bike4mind/client-auth

Client-side OAuth 2.0 Device Authorization Flow (RFC 8628) for the B4M clients that cannot host a
redirect URI: `packages/cli` and `apps/desktop`.

The package deliberately owns **no storage and no environment**. Anything host-specific is an input:

| Concern | Port |
|---|---|
| Where tokens live (config file, OS keychain) | `TokenStore` |
| Logging | `AuthLogger` |
| Which OAuth client is calling | `DeviceFlowClientOptions.clientId` |
| Re-auth wording ("run `b4m login`", "open Settings") | `ReauthMessages` |
| Build-time brand defaults | `selectApiEndpoint(inputs)` takes the resolved values |

That boundary is what keeps a Node-only concern (a dotfile path, `process.env`) out of a renderer
process. Keep it: a new export that reads `process.env` or touches `fs` belongs in the host.

## Surface

- `DeviceFlowClient` - `initiateDeviceFlow`, `pollForToken`, `waitForAuthorization` (respects
  `slow_down`, terminates on `access_denied` / `expired_token`), `refreshToken`.
- `AuthenticatedApiClient` - Bearer injection, refresh-and-retry on 401, `SessionRevokedError` for a
  definitive revocation (a plain `Error` for a transient refresh outage, so callers can keep
  retrying). An `apiKey` bypasses the JWT path entirely.
- `swapActiveEnvAuth` / `normalizeEnvKey` - per-environment token cache keyed by normalized API URL,
  so switching between hosted and self-hosted does not force a re-login.
- `selectApiEndpoint` / `parseApiUrl` / `ApiEndpoint` - endpoint resolution, with "unconfigured" as
  an explicit state rather than an empty string.
