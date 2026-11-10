# Turborepo Remote Cache

Self-hosted Turborepo remote cache backed by S3 and served by a Lambda function URL.
Avoids reliance on Vercel's remote cache and keeps build artifacts in the team's own
AWS account.

## Architecture

- **S3 bucket** (`turboCacheBucket`): stores cache artifacts keyed by content hash.
  A 30-day lifecycle expires artifacts that have not been hit, keeping the bucket bounded.
- **Lambda function** (`TurboCacheHandler`): implements the Turborepo v8 cache protocol
  (GET/PUT/HEAD artifacts, POST events). Exposed via a Function URL (no API Gateway).
- **Auth token** (`TURBO_CACHE_TOKEN` SST secret): shared bearer token verified on
  every request. Generate with `openssl rand -hex 32` and set per stage:

  ```bash
  sst secret set TURBO_CACHE_TOKEN "$(openssl rand -hex 32)" --stage production
  sst secret set TURBO_CACHE_TOKEN "$(openssl rand -hex 32)" --stage dev
  ```

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
- **Large artifacts timing out**: the Lambda has a 30-second timeout and 512 MB memory.
  Increase these in `infra/turborepoCache.ts` if needed.
