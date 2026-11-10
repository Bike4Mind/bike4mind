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

Configure `TURBO_API` for the selected hosted endpoint and store the write token
as the GitHub Actions secret `TURBO_TOKEN`. Trusted workflows can use:

```yaml
env:
  TURBO_API: ${{ secrets.TURBO_API }}
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: bike4mind
```

## Troubleshooting

- **401**: neither configured token matches the bearer credential.
- **403 on upload**: the token is read-only; CI needs the distinct write token.
- **400 on upload**: enable `remoteCache.preflight` in the consuming workspace.
- **Cache misses**: confirm the endpoint, team and task inputs match the writer.
- **Artifact size**: bytes travel directly to S3; single PUT uploads support up to
  5 GB. Split larger task outputs.
