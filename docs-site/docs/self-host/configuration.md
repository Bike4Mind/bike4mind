---
title: Configuration Reference
description: Every environment variable the self-host stack reads, grouped by subsystem
sidebar_position: 2
---

# Self-Host Configuration Reference

All configuration comes from a single `.env.selfhost` file, copied from [`.env.selfhost.example`](https://github.com/bike4mind/bike4mind/blob/main/.env.selfhost.example) in the repo root. The template is derived from the `@bike4mind/resource` config manifest, so it is the authoritative list of every variable the app reads. Compose consumes it via the mandatory `--env-file .env.selfhost` flag:

```bash
docker compose -f compose.selfhost.yaml --env-file .env.selfhost up -d
```

Required variables fail loudly when their feature runs; optional variables may stay unset (a blank value disables that integration).

## Core (required to boot)

| Variable | Purpose |
|---|---|
| `B4M_SELF_HOST` | Set to `true` to enable the self-host (no-AWS) build path |
| `APP_NAME` | App identifier, normally `bike4mind` |
| `APP_STAGE` | Deployment stage label, normally `selfhost` |
| `MONGODB_URI` | MongoDB connection string. Must point at a **replica set** (transactions require it): `mongodb://mongo:27017/bike4mind?replicaSet=rs0` |
| `JWT_SECRET` | Auth token signing key (32-byte hex, `openssl rand -hex 32`) |
| `SESSION_SECRET` | Session signing key (32-byte hex) |
| `SECRET_ENCRYPTION_KEY` | Encrypts secrets stored in the database (32-byte hex). Required: the stack will not start without a valid key. To change it, see [Rotating the encryption key](#rotating-the-encryption-key) |
| `B4M_ALLOW_PLAINTEXT_SECRETS` | Docker Compose only, evaluation only. Set to `true` to start with the template `SECRET_ENCRYPTION_KEY` value left in place (an empty key still stops the stack); stored secrets are then kept in plaintext, every process logs a warning at boot, and admin System Health shows a warning. Leave unset otherwise |

Set `B4M_BOOTSTRAP_ADMIN_EMAIL` to the email of the account that should become the admin on a fresh install. It is optional; if it is unset, the first account to register with the emailed code becomes the admin. Sign in with the emailed one-time code the first time, not OAuth (for example GitHub): the bootstrap applies only to the email-code sign-in.

**Upgrading an existing Compose install:** a Compose install that never set a valid `SECRET_ENCRYPTION_KEY` will not start after this change. Generate a key (`openssl rand -hex 32`), back it up, set it (and a persistent `MEMORY_KEY_SECRET` if you have none), and encrypt the rows already stored in plaintext with the credential migration commands in the "Upgrading an existing install" note in `SELF_HOST.md`. Key rotation alone does not encrypt existing plaintext, and sign-in provider tokens are only encrypted when each user next signs in. For a throwaway evaluation, set `B4M_ALLOW_PLAINTEXT_SECRETS=true` instead. `SECRET_ENCRYPTION_KEY_PREVIOUS` must be empty, `not-configured`, or 64 hex characters; anything else blocks startup.

If you rotate `SECRET_ENCRYPTION_KEY`, keep the old key configured as `SECRET_ENCRYPTION_KEY_PREVIOUS` until the steps in [Rotating the encryption key](#rotating-the-encryption-key) finish, so existing ciphertext stays readable.

The six secrets (these three plus `CHAT_COMPLETION_INTERNAL_SECRET`, `INTERNAL_WS_SECRET` and `INTERNAL_S3_WEBHOOK_SECRET`) are the **only values you must change**, and the app refuses to run while any of them still holds its `change-me` template value - everything else in the template already points at the bundled services.

## Local infra backends (bundled services)

Pre-filled for the compose stack; change them only for production hardening or if you bring your own services.

| Group | Variables | Bundled service |
|---|---|---|
| Object storage | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, plus the `*_BUCKET` names | MinIO |
| Queues | `AWS_ENDPOINT_URL_SQS` plus the `*_QUEUE` URLs (predeclared in `elasticmq.conf`) | ElasticMQ |
| Mail | `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM` | Mailpit (UI at `http://localhost:8025`) |
| Realtime | `WEBSOCKET_URL` (browser-facing), `WEBSOCKET_MANAGEMENT_ENDPOINT` (server-facing) | Bundled `ws` gateway and `subscriber-fanout` |

For real outbound email, point the `MAIL_*` variables at an SMTP provider. Use port `465` for implicit TLS.

## LLM providers

Set keys only for the providers you want available. Only models for providers with a configured key appear in the model picker; Bedrock-backed models are hidden on self-host unless `BEDROCK_AWS_ACCESS_KEY_ID` and `BEDROCK_AWS_SECRET_ACCESS_KEY` are set. Users can also add or override keys per-user in the app under **Profile menu -> More -> API Keys** (stored encrypted with `SECRET_ENCRYPTION_KEY`).

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI GPT |
| `GEMINI_API_KEY` | Google Gemini |
| `XAI_API_KEY` | xAI Grok |

Local models via **Ollama** need no API key - see [Local Models](/cli/local-models).

## Optional integrations

Each of these is fully optional; leaving the variables blank disables the integration.

| Group | Variables | Enables |
|---|---|---|
| GitHub OAuth | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | "Sign in with GitHub" and GitHub tools |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Sign in with Google" and Google tools |
| Okta | `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET`, `OKTA_AUDIENCE` | Enterprise SSO |
| Stripe | `STRIPE_*` | Billing (hosted-service feature; not needed for self-host - credit metering is off by default) |
| Slack | `SLACK_*` | Slack integration |
| Signing secret | `HMAC_SIGNING_SECRET`, `HMAC_SIGNING_SECRET_PREVIOUS` | A dedicated key for signed image URLs and hashed identifiers (`openssl rand -hex 32`). While `HMAC_SIGNING_SECRET` is blank, `SECRET_ENCRYPTION_KEY` is used. Put the outgoing secret in `HMAC_SIGNING_SECRET_PREVIOUS` and keep it for at least 90 days, the telemetry retention window |

## Rotating the encryption key

`SECRET_ENCRYPTION_KEY` encrypts secrets stored in the database. Reads fall back to `SECRET_ENCRYPTION_KEY_PREVIOUS`, but a stored value is not re-encrypted when it is read, so you finish a rotation with a command that rewrites every stored value under the new key. Take a backup first.

1. In `.env.selfhost`, copy the current `SECRET_ENCRYPTION_KEY` value to `SECRET_ENCRYPTION_KEY_PREVIOUS`, then set `SECRET_ENCRYPTION_KEY` to a new value (`openssl rand -hex 32`). If `HMAC_SIGNING_SECRET` is empty, signed links and hashed identifiers are keyed with `SECRET_ENCRYPTION_KEY`: to keep the ones issued so far valid, also set `HMAC_SIGNING_SECRET_PREVIOUS` to the old key and `HMAC_SIGNING_SECRET` to another new value.
2. Recreate the services so they load the new values:

   ```bash
   docker compose -f compose.selfhost.yaml --env-file .env.selfhost up -d
   ```

3. From the repo checkout on the host (Node and `pnpm install`), run the re-encrypt command against the published Mongo port. It reads the two keys and the database URI from the environment. Use the URI from `.env.selfhost` with the host changed to `localhost` and your published port, plus `directConnection=true`:

   ```bash
   export SECRET_ENCRYPTION_KEY="$(grep '^SECRET_ENCRYPTION_KEY=' .env.selfhost | cut -d= -f2-)"
   export SECRET_ENCRYPTION_KEY_PREVIOUS="$(grep '^SECRET_ENCRYPTION_KEY_PREVIOUS=' .env.selfhost | cut -d= -f2-)"
   export MONGODB_URI='mongodb://localhost:27017/bike4mind?replicaSet=rs0&directConnection=true'
   pnpm --filter @bike4mind/scripts migrate:reencrypt-stored-secrets --dry-run
   pnpm --filter @bike4mind/scripts migrate:reencrypt-stored-secrets
   pnpm --filter @bike4mind/scripts migrate:reencrypt-stored-secrets --verify
   ```

   `--dry-run` writes nothing and reports what a run would rewrite. The output is counts per stored field; no value is printed. Exit code 0 means every stored value is under the new key, 1 means some values are unreadable or changed while the command ran (run it again), and 2 means a usage or connection error, or a database with nothing encrypted in it.
4. Only after `--verify` exits 0, empty `SECRET_ENCRYPTION_KEY_PREVIOUS` in `.env.selfhost` and recreate the services again. Until then keep it set: anything still encrypted under the old key is unrecoverable without it.

## Gotchas

- **No inline comments after values.** Docker Compose env files take values verbatim - a trailing `# comment` on the same line becomes part of the value. Keep comments on their own lines.
- **Set the bootstrap admin email.** On a fresh install, the account whose email matches `B4M_BOOTSTRAP_ADMIN_EMAIL` skips the invite check and gets admin rights. Set it before the first start. If it is unset, the first account to register with the emailed code becomes admin instead, so register it yourself before exposing the instance. Later signups are invite-gated until the admin enables open registration.
- **Replica set is mandatory.** A standalone `mongod` without `--replSet` breaks transactional writes with "no primary" errors.
- **Local, single-host defaults.** The bundled services are unauthenticated and loopback-bound. Before public exposure: enable Mongo auth, change MinIO credentials, use real SMTP, and front the app with TLS - see the [security notes](/self-host#security-notes) and the `compose.selfhost.yaml` header.
