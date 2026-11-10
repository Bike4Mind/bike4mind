# Turborepo Remote Cache

Self-hosted Turborepo remote cache backed by S3 and served by a Lambda function URL.
Avoids reliance on Vercel's remote cache and keeps build artifacts in the team's own
AWS account.

## Architecture

- **S3 bucket** (`turboCacheBucket`): stores cache artifacts keyed by content hash.
  A 30-day lifecycle expires artifacts that have not been hit, keeping the bucket bounded.
- **Lambda function** (`TurboCacheHandler`): implements the Turborepo v8 cache protocol
  (GET/PUT/HEAD artifacts, POST events). Exposed via a Function URL (no API Gateway).
  GET and PUT use presigned S3 URLs (302/307 redirects), so artifact bytes never pass
  through Lambda and are not subject to its 6 MB payload limit.
- **Auth token** (`TURBO_CACHE_TOKEN` SST secret): bearer token verified on every
  request. Generate with `openssl rand -hex 32` and set on the hosted stages:

  ```bash
  sst secret set TURBO_CACHE_TOKEN "$(openssl rand -hex 32)" --stage production
  sst secret set TURBO_CACHE_TOKEN "$(openssl rand -hex 32)" --stage dev
  ```

- **Stage gating**: the cache stack deploys only on hosted stages (`production`, `dev`)
  so all developers and CI share one cache. Per-dev and preview stages skip deployment.

## Security

### Artifact signing

Enable Turborepo's built-in artifact signature verification to prevent cache poisoning.
Add to `turbo.json`:

```json
{
  "remoteCache": {
    "signature": true
  }
}
```

Then set a signing key (keep it in CI only, never on developer laptops):

```bash
# CI-only secret
export TURBO_REMOTE_CACHE_SIGNATURE_KEY="$(openssl rand -hex 32)"
```

With signing enabled, CI signs every artifact it uploads. A developer laptop can still
read cached artifacts but cannot upload a poisoned one that CI would later trust.

### Token separation (recommended)

For stronger isolation, use separate tokens:
- **CI token** (read/write): set as a GitHub Actions secret
- **Developer token** (read-only): distributed to `.env.local`

Read-only enforcement requires a second Lambda or a token-to-permission map in the
handler; as a first step, artifact signing alone prevents the cache-poisoning vector.

## Local development

Set the following environment variables (e.g. in `.env.local` or your shell profile):

```bash
export TURBO_API=<turboCacheUrl from sst output>
export TURBO_TOKEN=<the token you set above>
export TURBO_TEAM=bike4mind
```

Then run any turbo command as usual. Cache hits are served from S3; misses are uploaded
after the task completes.

## CI integration

Add the same three variables as GitHub Actions secrets and reference them in the
workflow `env` block:

```yaml
env:
  TURBO_API: ${{ secrets.TURBO_API }}
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: bike4mind
```

## Troubleshooting

- **401 Unauthorized**: the `TURBO_CACHE_TOKEN` secret is either unset (`not-configured`)
  or the `TURBO_TOKEN` env var does not match.
- **Cache misses on every run**: verify `TURBO_API` points at the deployed Function URL
  (check `sst output` for `turboCacheUrl`).
- **Artifact size**: GET/PUT use presigned S3 URLs, so there is no Lambda payload limit
  on artifact size. S3 supports objects up to 5 GB via single PUT. If artifacts exceed
  5 GB, consider splitting turbo task outputs.
