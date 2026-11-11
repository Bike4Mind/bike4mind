# Turborepo Remote Cache

Self-hosted Turborepo remote cache backed by S3 and a Lambda Function URL.

## Architecture

- The `turboCacheBucket` stores artifacts by team and content hash. Its lifecycle
  expires objects 30 days after creation; reads do not extend that lifetime.
- `TurboCacheHandler` implements GET/HEAD artifacts and POST analytics events.
  GET checks existence and redirects downloads to a presigned S3 URL.
- The root `turbo.json` enables `remoteCache.preflight`. Turbo first sends an
  authenticated OPTIONS request for uploads, then sends the artifact directly
  to the returned presigned S3 URL. No upload body enters Lambda, avoiding its
  request payload limit and streaming-body redirect retries. Direct PUT requests
  fail with an instruction to enable preflight.
- GET/HEAD preflights remain at Lambda because Turbo also preflights HEAD using
  GET. HEAD returns object metadata without fetching the artifact body.
- Managed Function URL CORS is disabled so the handler controls preflight headers.
  Upload preflights omit Authorization from allowed headers; Turbo must not send
  the cache bearer token to S3 alongside the URL signature.
- The stack deploys only on hosted stages (`production`, `dev`), outside SST dev.
  Developer and preview stages create no cache resources. Each hosted stage has
  its own bucket; choose one endpoint for a shared cache.
- The Function URL is public with bearer auth in the handler, so the function runs
  under a reserved concurrency cap. The `slug`/`teamId` query value becomes the key
  prefix and must match `[A-Za-z0-9_-]{1,64}`; anything else returns 400.
- Both tokens are declared in `infra/turborepoCache.ts` and linked into the cache
  handler only, never into the shared `infra/secrets.ts` map that every app Lambda links.

## Contract-gate exception

The Function URL scanner explicitly permits only the declaration in
`infra/turborepoCache.ts` targeting `apps/workers/src/turboCache/handler.handler`.
This permanent third-party protocol exception is separate from the frozen
migration-debt allowlist, which remains unchanged. Other declarations and handler
exports still require `defineLambdaRoute`.

Turbo fixes the v8 paths and requires OPTIONS preflight, HEAD metadata and redirect
headers across multiple methods. The app's JSON contract adapter uses app
credentials and JSON response shaping; this transport instead owns bearer-token
validation and read/write roles before dispatching any protocol route, including
analytics events. It does not expose an app API-key endpoint or app OpenAPI contract.

Scanner integration tests cover the exact exception and rejection of other
bindings, missing handlers and malformed declarations. Handler tests cover
unauthenticated requests and read-only upload rejection, while a real AWS signer
regression covers body-independent upload URLs.

## Access control

Set two distinct secrets on the hosted stage:

```bash
sst secret set TURBO_CACHE_TOKEN "$(openssl rand -hex 32)" --stage production
sst secret set TURBO_CACHE_READ_TOKEN "$(openssl rand -hex 32)" --stage production
```

`TURBO_CACHE_TOKEN` grants read/write access. Keep it in trusted CI secrets only;
never expose it to untrusted pull-request jobs or developer environments.
`TURBO_CACHE_READ_TOKEN` grants read access and is suitable for developers. The
handler rejects both direct writes and upload preflights using this token.
Unset secrets deny access. Identical secrets receive only read permission.
Analytics events are accepted without storing data for either token.

Anyone holding the CI token can publish artifacts that CI trusts. Rotate it if
exposed. Presigned URLs remain usable until their 15-minute expiry, including
URLs issued before token rotation. Artifact signatures are not enabled by this
transport: direct S3 downloads do not supply Turbo's signature response header.

## Local development

Set these in the shell running Turbo:

```bash
export TURBO_API=<turboCacheUrl from sst output>
export TURBO_TOKEN=<TURBO_CACHE_READ_TOKEN value>
export TURBO_TEAM=bike4mind
```

Developers can restore remote hits. Upload attempts are rejected; local caching
continues to work. To skip remote upload attempts, pass `--cache=local:rw,remote:r`.
Keep `remoteCache.preflight` enabled when using this endpoint.

## CI integration

### Trust model

The write token is the cache's integrity boundary. Anyone holding it can publish
artifacts that CI trusts, so treat it as a deployment credential:

- **`push` to `main` only**: store `TURBO_CACHE_TOKEN` in a GitHub Environment
  restricted to `main` (`production` or a dedicated `turbo-cache` environment),
  not as a repo-level Actions secret. Only jobs triggered by a merge to `main`
  receive write access.
- **Pull-request and merge-group jobs**: supply `TURBO_CACHE_READ_TOKEN` (or no
  token) so untrusted code cannot poison the cache. `pull_request` workflows
  from forks never receive either token.
- **Release and deploy builds**: run with `--cache=local:rw` (no remote restore)
  so production artifacts are built from source, not from a cache that any
  `main`-push job could have written to. If a future deploy workflow restores
  from the remote cache, document the reason and the rollback path here.

Artifact signatures are not enabled by this transport (direct S3 downloads do
not carry Turbo's signature header), so these workflow rules are the entire
write-trust boundary.

### Workflow setup

Configure `TURBO_API` for the selected hosted endpoint and store the write token
in the restricted GitHub Environment. Trusted workflows can use:

```yaml
env:
  TURBO_API: ${{ secrets.TURBO_API }}
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: bike4mind
```

Read-only workflows (PR CI) use the read token instead:

```yaml
env:
  TURBO_API: ${{ secrets.TURBO_API }}
  TURBO_TOKEN: ${{ secrets.TURBO_CACHE_READ_TOKEN }}
  TURBO_TEAM: bike4mind
```

## Troubleshooting

- **401**: neither configured token matches the bearer credential.
- **403 on upload**: the token is read-only; CI needs the distinct write token.
- **400 on upload**: enable `remoteCache.preflight` in the consuming workspace.
- **Cache misses**: confirm the endpoint, team and task inputs match the writer.
- **Artifact size**: bytes travel directly to S3; single PUT uploads support up to
  5 GB. Split larger task outputs.
