# Secrets-at-rest KMS key

A KMS key wraps a per-stage data key (`SECRET_ENCRYPTION_KEY_WRAPPED`). Nothing reads the blob yet; the keyring that consumes it is separate work.

## Where the key lives

| Stage | Key |
| --- | --- |
| `production`, `dev` (staging) | Dedicated key, alias `alias/<app>-<stage>-secrets-at-rest`, created in `infra/secretsAtRestKey.ts` |
| Previews (`pr<N>`) | One shared key owned outside any stage; its ARN is passed as `PREVIEW_SECRETS_AT_REST_KEY_ARN`. Unset means no key and no grant |
| Personal stages | None |

The key policy (`secretsAtRestKeyPolicy`) denies `Decrypt` unless the encryption context is `{ purpose: secrets-at-rest, stage: <stage> }` and the caller is one of the stage's Functions or the ChatCompletion task role. Operators can mint a blob with `GenerateDataKeyWithoutPlaintext` but cannot unwrap one. A `Decrypt` by any other caller raises a critical alarm.

## Minting the blob

```bash
pnpm --filter @bike4mind/scripts create-wrapped-stage-data-key --stage <stage> [--key <alias|arn>] --dry-run
pnpm --filter @bike4mind/scripts create-wrapped-stage-data-key --stage <stage> [--key <alias|arn>]
```

Re-running says "already set" and changes nothing; `--force` replaces the blob. Previews require `--key`.

## Checking reachability

Invoke the `SecretsAtRestUnwrapProbe` function manually. It returns `{ ok, decryptMs, coldStart }`. VPC functions reach KMS through the NAT; no interface endpoint is used.

A revoked grant does not take effect in a warm container until its cached credentials expire.
