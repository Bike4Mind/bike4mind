# Secrets-at-rest KMS key

A KMS key wraps a per-stage data key (`SECRET_DATA_KEY_WRAPPED`). The keyring selects the `aws-kms` provider when this secret is set and stays on the static key otherwise, so minting a stage switches its active key. The name and the encryption-context purpose are exported from `@bike4mind/common` and used by infra, the mint script, the probe and the keyring.

## Where the key lives

| Stage | Key |
| --- | --- |
| `production`, `dev` (staging) | Dedicated key, alias `alias/<app>-<stage>-secrets-at-rest`, created in `infra/secretsAtRestKey.ts` |
| Previews (`pr<N>`) | One shared key owned outside any stage; its ARN is passed as `PREVIEW_SECRETS_AT_REST_KEY_ARN`. Unset means no key and no grant |
| Personal stages | None |

The key policy (`secretsAtRestKeyPolicy`) denies `Decrypt` unless the encryption context is `{ purpose: secrets-at-rest, stage: <stage> }` and the caller's role carries the tag `b4m:secrets-at-rest-stage=<stage>`. A global transform in `sst.config.ts` puts that tag on every IAM role the stack creates, so the stage's Functions and the ChatCompletion task role qualify and operators do not. The callable-function sandbox role is the one exception and stays untagged. Operators can mint a blob with `GenerateDataKeyWithoutPlaintext`; `GenerateDataKey` and `Encrypt` under the purpose context, and `ReEncrypt`, are denied to everyone, so nobody can plant a data key whose plaintext they know.

The shared preview key's owner creates it with `secretsAtRestPreviewKeyPolicy`, which is the same policy pinned to any stage whose name matches `pr*` instead of one, and carries the alarms below.

On production and `dev`, two critical alarms cover the key. Previews have no alarm topic, and the shared preview key's owner carries its own.

- A `Decrypt` on the key was refused.
- The key policy, a grant or the key lifecycle changed (`PutKeyPolicy`, `CreateGrant`, `ScheduleKeyDeletion`, `DisableKey`, `DisableKeyRotation`).

Both rules match `AWS API Call via CloudTrail` events, which EventBridge receives only from a CloudTrail trail that is logging management events; the refused-Decrypt rule also needs read events, with KMS events not excluded. This stack does not create a trail; the account must have one for the alarms to fire.

## Minting the blob

```bash
pnpm --filter @bike4mind/scripts create-wrapped-stage-data-key --stage <stage> [--key <alias|arn>] --dry-run
pnpm --filter @bike4mind/scripts create-wrapped-stage-data-key --stage <stage> [--key <alias|arn>]
```

Re-running says "already set" and changes nothing. The script never replaces a set blob: it is the only copy of the data key, and a new one makes everything encrypted under the old one unreadable. Rotating it needs a keyring that reads two wrapped keys; until then, do not rotate. `--app` is passed to sst as `SEED_APP_NAME`. Previews require `--key`.

## Checking reachability

Invoke the `SecretsAtRestUnwrapProbe` function manually. It returns `{ ok, decryptMs, coldStart }`. VPC functions reach KMS through the NAT; no interface endpoint is used.

A revoked grant does not take effect in a warm container until its cached credentials expire.
