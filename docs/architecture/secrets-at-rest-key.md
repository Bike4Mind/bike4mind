# Secrets-at-rest KMS key

A KMS key wraps a per-stage data key (`SECRET_ENCRYPTION_KEY_WRAPPED`). The keyring that consumes it is separate work; until it lands, only the reachability probe unwraps the blob.

## Where the key lives

| Stage | Key |
| --- | --- |
| `production`, `dev` (staging) | Dedicated key, alias `alias/<app>-<stage>-secrets-at-rest`, created in `infra/secretsAtRestKey.ts` |
| Previews (`pr<N>`) | One shared key owned outside any stage; its ARN is passed as `PREVIEW_SECRETS_AT_REST_KEY_ARN`. Unset means no key and no grant |
| Personal stages | None |

The key policy (`secretsAtRestKeyPolicy`) denies `Decrypt` unless the encryption context is `{ purpose: secrets-at-rest, stage: <stage> }` and the caller's role carries the tag `b4m:secrets-at-rest-stage=<stage>`. A global transform in `sst.config.ts` puts that tag on every IAM role the stack creates, so the stage's Functions and the ChatCompletion task role qualify and operators do not. Operators can mint a blob with `GenerateDataKeyWithoutPlaintext`; `GenerateDataKey` and `Encrypt` under the purpose context are denied to everyone, so nobody can plant a data key whose plaintext they know.

The shared preview key's owner creates it with `secretsAtRestPreviewKeyPolicy`, which is the same policy pinned to any `pr*` stage instead of one, and carries the alarms below.

On production and `dev`, three critical alarms cover the key. Previews have no alarm topic, and the shared preview key's owner carries its own.

- A `Decrypt` on the key was refused.
- A `Decrypt` on the key succeeded for a caller that is not one of the stage's app roles (named `<app>-<stage>-...`).
- The key policy, a grant or the key lifecycle changed (`PutKeyPolicy`, `CreateGrant`, `ScheduleKeyDeletion`, `DisableKey`, `DisableKeyRotation`).

Residual: the stage tag is the only Decrypt barrier for an IAM admin, who can create or tag a role, or pass the tag as a session tag, and then unwrap. The success-path alarm detects that unwrap after the fact; it does not prevent it. Preventing it is an account-level control (for example a service control policy denying `aws:TagKeys` for `b4m:secrets-at-rest-stage` outside the deploy role) and is the infra owner's call.

## Minting the blob

```bash
pnpm --filter @bike4mind/scripts create-wrapped-stage-data-key --stage <stage> [--key <alias|arn>] --dry-run
pnpm --filter @bike4mind/scripts create-wrapped-stage-data-key --stage <stage> [--key <alias|arn>]
```

Re-running says "already set" and changes nothing; `--force` replaces the blob. Previews require `--key`.

## Checking reachability

Invoke the `SecretsAtRestUnwrapProbe` function manually. It returns `{ ok, decryptMs, coldStart }`. VPC functions reach KMS through the NAT; no interface endpoint is used.

A revoked grant does not take effect in a warm container until its cached credentials expire.
