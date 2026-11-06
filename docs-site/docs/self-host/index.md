---
title: Self-Host Quickstart
description: Run the open core of Bike4Mind on your own hardware with Docker Compose - no AWS account required
sidebar_position: 1
slug: /self-host
---

# Self-Host Quickstart

Run the open core of Bike4Mind on your own hardware - a laptop, a server, or your own cloud - with **no AWS account or hyperscaler required**. The app plus its dependencies (MongoDB, object storage, queues, and a local mail catcher) run as containers via Docker Compose.

**The standard path, at a glance** (each step is a section below):

1. Clone the repo and copy the env template.
2. Generate the three security secrets and set your LLM provider key(s).
3. `docker compose -f compose.selfhost.yaml --env-file .env.selfhost up -d`
4. Sign in at `http://localhost:3000` with a one-time code read from Mailpit at `http://localhost:8025`. The account whose email matches `B4M_BOOTSTRAP_ADMIN_EMAIL` becomes the admin (if it is unset, the first account to register with the emailed code does).
5. Create an API key in the app and make your first API call with `curl`.

Prefer to run on AWS instead? See the [Deployment Guide](/deployment) for the full SST-based cloud path. Want to hack on the code? That's a separate flow - see the [Development Setup](/getting-started/development) and the repo's [Contributing Guide](https://github.com/bike4mind/bike4mind/blob/main/CONTRIBUTING.md); this page is about **running** Bike4Mind.

## Prerequisites

- **Docker** and **Docker Compose** (Docker Desktop, or Docker Engine + the compose plugin).
- ~4 GB free RAM for the stack (more if you build the image yourself, see below).
- API keys for whichever LLM providers you want to use (Anthropic, OpenAI, Google Gemini, xAI, or a local Ollama endpoint).

You do **not** need Node, pnpm, or a local build - the app ships as a prebuilt image at `ghcr.io/bike4mind/bike4mind-selfhost` (multi-arch: amd64 + arm64), published by CI from `main`.

## 1. Get the compose files

Clone the repo (or copy `compose.selfhost.yaml`, `elasticmq.conf`, and `.env.selfhost.example` from it):

```bash
git clone https://github.com/bike4mind/bike4mind.git
cd bike4mind
```

## 2. Configure your environment

Copy the template and fill it in:

```bash
cp .env.selfhost.example .env.selfhost
```

**Generate the three security secrets** (each a fresh 32-byte hex string):

```bash
openssl rand -hex 32   # -> JWT_SECRET
openssl rand -hex 32   # -> SESSION_SECRET
openssl rand -hex 32   # -> SECRET_ENCRYPTION_KEY
```

:::warning
**Do not rotate `SECRET_ENCRYPTION_KEY` casually.** It encrypts secrets stored in the database. If you change it, set `SECRET_ENCRYPTION_KEY_PREVIOUS` to the old key and keep it configured permanently so existing ciphertext remains readable; rotation is not automated.
:::

:::note Formatting
Compose reads `.env.selfhost` values verbatim - don't add comments on the same line as a value.
:::

**Minimum required to boot:** the defaults in the template already point everything (MongoDB, MinIO object storage, ElasticMQ queues, Mailpit mail catcher) at the bundled services - you only need to set the three secrets above.

**Choose the admin account** - set `B4M_BOOTSTRAP_ADMIN_EMAIL` to the email address you will sign in with, before you start the stack for the first time. That account becomes the admin on first sign-in. Sign in with the emailed one-time code the first time, not OAuth (for example GitHub): the bootstrap applies only to the email-code sign-in. If you leave it unset, the first account to register with the emailed code becomes the admin.

```bash
B4M_BOOTSTRAP_ADMIN_EMAIL=you@example.com
```

**LLM keys** - set the ones you'll use; blank disables that provider. Only models for providers with a key appear in the model picker. You can also add or override keys per-user later, in the app under Profile menu -> More -> API Keys.

```bash
ANTHROPIC_API_KEY=      # Claude
OPENAI_API_KEY=         # GPT
GEMINI_API_KEY=         # Google Gemini
XAI_API_KEY=            # Grok
# ...plus optional GitHub/Google OAuth, Stripe, Slack - see the template
```

## 3. Bring up the stack

```bash
docker compose -f compose.selfhost.yaml --env-file .env.selfhost up -d
```

This pulls the app image and starts it alongside MongoDB, MinIO, ElasticMQ, and Mailpit. When it's healthy, open:

```
http://localhost:3000
```

**Building from source instead** (optional): the prebuilt image is the supported path, but you can build locally with `docker compose -f compose.selfhost.yaml --env-file .env.selfhost build`. The Next.js monorepo build needs ~12-16 GB of Docker memory (Docker Desktop: Settings > Resources).

## 4. Sign in

Bike4Mind signs you in with a one-time code sent by email. In the self-host stack, all outgoing mail is caught by the bundled **Mailpit** - nothing leaves your machine:

1. Open `http://localhost:3000`, enter your email address, and request a code.
2. Open Mailpit at **`http://localhost:8025`** and read the code from the sign-in email.
3. Enter the code and pick a username.

**On a fresh install, the account whose email matches `B4M_BOOTSTRAP_ADMIN_EMAIL` becomes the admin** (no invite code needed). Set it before the first start. If it is unset, the first account to register with the emailed code becomes the admin instead. An install that has users but no admin (for example after a failed first sign-in) promotes the configured account on its next sign-in. After that, invite-only registration applies - as admin you can issue invites or enable open registration in the admin settings.

For production use, point the `MAIL_*` variables at a real SMTP provider instead of Mailpit.

## 5. Make your first API call

Everything you can do in the UI is also available over the HTTP API, authenticated with a scoped API key.

1. **Create an API key**: in the app, open **Profile menu -> More -> API Keys** and create a key with the `ai:chat` scope. The key (starting `b4m_`) is shown once - copy it.

2. **Send a chat message**:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "x-api-key: $B4M_API_KEY" \
  -H "content-type: application/json" \
  -d '{"message": "Say hello in five words.", "wait": true}'
```

`wait: true` processes the message synchronously and returns the reply in the response; omit it to get a `sessionId`/`questId` back immediately and let processing continue in the background. The model defaults to the admin `DefaultAPIModel` setting; pass `"model": "..."` to pick any model from `/api/models` (only providers you configured a key for are available).

The same header works as `Authorization: ApiKey <key>`. Keys, scopes, and rate limits are managed per-user in Profile menu -> More -> API Keys.

## Troubleshooting

- **App can't reach Mongo / "no primary" errors** - MongoDB must run as a replica set (`--replSet rs0`) for transactions; the bundled `mongo` service is configured for this. Give it a few seconds to elect a primary on first boot.
- **No sign-in email arrives** - check Mailpit at `http://localhost:8025`; if it's empty, check `docker compose -f compose.selfhost.yaml logs app` for mail errors and verify the `MAIL_*` values.
- **A model returns "unauthorized"** - that provider's API key is missing or wrong in `.env.selfhost`. Only the providers you set keys for are available.
- **The model picker is empty / "no models" warning** - no provider key is configured. Set at least one provider key in `.env.selfhost` and restart (`docker compose -f compose.selfhost.yaml --env-file .env.selfhost up -d`), or add a key in the app under Profile menu -> More -> API Keys.
- **Chat replies only appear after a refresh** - check that the bundled `ws` and `subscriber-fanout` services are running and that `WEBSOCKET_URL` and `WEBSOCKET_MANAGEMENT_ENDPOINT` point at the gateway. Inspect `docker compose -f compose.selfhost.yaml logs ws` and the subscriber-fanout logs for connection failures.
- **Changed `SECRET_ENCRYPTION_KEY` and now secrets fail to decrypt** - restore the original key, or set `SECRET_ENCRYPTION_KEY_PREVIOUS` to it and keep it configured permanently. Recreate the services to load the environment changes. Dropping the previous key makes data still encrypted under it unreadable.

## Security notes

The stack is configured for **local, single-host use**: the backing services (Mongo, MinIO, ElasticMQ, Mailpit) run without authentication and bind to `127.0.0.1` only. Before running on a public-facing server you must enable Mongo auth, change the MinIO credentials, use a real SMTP provider, and put the app behind a reverse proxy with TLS. See the header of `compose.selfhost.yaml`.

## What you get (and don't)

Self-host runs the open-core engine - notebooks, multi-LLM chat, agents, the Quest Master, the knowledge engine, and artifacts. Credit metering is **off by default** on self-host (the admin can turn it on) - no Stripe, no billing. Bedrock-backed models are hidden on self-host unless `BEDROCK_AWS_ACCESS_KEY_ID` and `BEDROCK_AWS_SECRET_ACCESS_KEY` are set; only providers with a configured key appear.

Runtime services and hosted-only gaps:

- **Realtime streaming** - the bundled `ws` gateway and `subscriber-fanout` service support streamed replies and live document updates. Both must be running with the matching connection settings.
- **Background enrichment** - the bundled `worker` consumes `SELF_HOST_EVENT_QUEUE` for mementos, session auto-naming, summaries and tagging. Check the worker and queue configuration if these features do not run.
- **Hosted-service features** - billing, entitlements, and premium overlays are not part of the open core; see the [open/closed boundary](https://github.com/bike4mind/bike4mind/blob/main/CONTRIBUTING.md#the-openclosed-boundary).

Need help? Ask in [Discussions](https://github.com/bike4mind/bike4mind/discussions).
