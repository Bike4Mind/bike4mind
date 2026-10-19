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
| `SECRET_ENCRYPTION_KEY` | Encrypts secrets stored in the database (32-byte hex). **Cannot be rotated after first boot** |

The three secrets are the **only values you must change** - everything else in the template already points at the bundled services.

## Local infra backends (bundled services)

Pre-filled for the compose stack; change them only for production hardening or if you bring your own services.

| Group | Variables | Bundled service |
|---|---|---|
| Object storage | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, plus the `*_BUCKET` names | MinIO |
| Queues | `AWS_ENDPOINT_URL_SQS` plus the `*_QUEUE` URLs (predeclared in `elasticmq.conf`) | ElasticMQ |
| Mail | `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM` | Mailpit (UI at `http://localhost:8025`) |
| Realtime | `WEBSOCKET_URL` (browser-facing), `WEBSOCKET_MANAGEMENT_ENDPOINT` (server-facing) | Gateway not in the stack yet - live updates degrade to fetch-on-refresh |

For real outbound email, point the `MAIL_*` variables at an SMTP provider. Use port `465` for implicit TLS.

## LLM providers

Set keys only for the providers you want available. Only models for providers with a configured key appear in the model picker; Bedrock-backed models are hidden on self-host. Users can also add or override keys per-user in the app under **Settings > API Keys** (stored encrypted with `SECRET_ENCRYPTION_KEY`).

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

## Gotchas

- **No inline comments after values.** Docker Compose env files take values verbatim - a trailing `# comment` on the same line becomes part of the value. Keep comments on their own lines.
- **First registered user becomes admin.** On a fresh install, the first registration skips the invite check and gets admin rights. Do it yourself before exposing the instance. Later signups are invite-gated until the admin enables open registration.
- **Replica set is mandatory.** A standalone `mongod` without `--replSet` breaks transactional writes with "no primary" errors.
- **Local, single-host defaults.** The bundled services are unauthenticated and loopback-bound. Before public exposure: enable Mongo auth, change MinIO credentials, use real SMTP, and front the app with TLS - see the [security notes](/self-host#security-notes) and the `compose.selfhost.yaml` header.
