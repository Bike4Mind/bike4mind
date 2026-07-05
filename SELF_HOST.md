# Self-Host Quickstart

Run the open core of Bike4Mind on your own hardware - a laptop, a server, or your own cloud - with **no AWS account or hyperscaler required**. The app plus its dependencies (MongoDB, object storage, queues, and a local mail catcher) run as containers via Docker Compose.

**The standard path, at a glance** (each step is a section below):

1. Clone the repo and copy the env template.
2. Generate the three security secrets and set your LLM provider key(s).
3. `docker compose -f compose.selfhost.yaml --env-file .env.selfhost up -d`
4. Sign in at `http://localhost:3000` with a one-time code read from Mailpit at `http://localhost:8025`. The first account becomes the admin.
5. Create an API key in the app and make your first API call with `curl`.

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

> **Never change `SECRET_ENCRYPTION_KEY` after first boot.** It encrypts other secrets stored in the database - rotating it makes existing encrypted data unreadable.

> **Formatting:** compose reads `.env.selfhost` values verbatim - don't add comments on the same line as a value.

**Minimum required to boot:** the defaults in the template already point everything (MongoDB, MinIO object storage, ElasticMQ queues, Mailpit mail catcher) at the bundled services - you only need to set the three secrets above.

**LLM keys** - set the ones you'll use; blank disables that provider. Only models for providers with a key appear in the model picker. You can also add or override keys per-user later, in the app under Settings > API Keys.

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

**Building from source**: if the `docker pull` step fails with `unauthorized` or `manifest unknown` (the CI-published image is not available to your account, or hasn't been published yet), build the image locally instead:

```bash
docker compose -f compose.selfhost.yaml --env-file .env.selfhost build
```

Compose tags the build with the same name the stack expects, so the subsequent `up` uses your local image and won't try to pull. The Next.js monorepo build needs ~12-16 GB of memory available to Docker (Docker Desktop: Settings > Resources; on Linux this is just host RAM). A from-source build takes several minutes and produces a ~1 GB image.

## 4. Sign in

Bike4Mind signs you in with a one-time code sent by email. In the self-host stack, all outgoing mail is caught by the bundled **Mailpit** - nothing leaves your machine:

1. Open `http://localhost:3000`, enter your email address, and request a code.
2. Open Mailpit at **`http://localhost:8025`** and read the code from the sign-in email.
3. Enter the code and pick a username.

**The first account created on a fresh install automatically becomes the admin** (no invite code needed). After that, invite-only registration applies - as admin you can issue invites or enable open registration in the admin settings.

For production use, point the `MAIL_*` variables at a real SMTP provider instead of Mailpit.

## 5. Make your first API call

Everything you can do in the UI is also available over the HTTP API, authenticated with a scoped API key.

1. **Create an API key**: in the app, open **Settings > API Keys** and create a key with the `ai:chat` scope. The key (starting `b4m_`) is shown once - copy it.

2. **Send a chat message**:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "x-api-key: $B4M_API_KEY" \
  -H "content-type: application/json" \
  -d '{"message": "Say hello in five words.", "wait": true}'
```

`wait: true` processes the message synchronously and returns the reply in the response; omit it to get a `sessionId`/`questId` back immediately and let processing continue in the background. The model defaults to the admin `DefaultAPIModel` setting; pass `"model": "..."` to pick any model from `/api/models` (only providers you configured a key for are available).

The same header works as `Authorization: ApiKey <key>`. Keys, scopes, and rate limits are managed per-user in Settings > API Keys.

## Troubleshooting

- **`docker pull` fails with `unauthorized` / `manifest unknown`** - the prebuilt image isn't available to your account (or isn't published yet). Build it from source instead - see "Building from source" in step 3.
- **`Error ... address already in use` / `failed to bind host port`** - another process on your host already owns one of the published ports (a local `mongod` on 27017 is the common one; also 3000, 9000, 9001, 9324, 9325, 8025). Override just the host side with the matching `*_HOST_PORT` var in `.env.selfhost` (e.g. `MONGO_HOST_PORT=27018`) - the services still reach each other over the compose network on their fixed internal ports, so nothing else needs to change.
- **MongoDB crashes on first boot with `WT_PANIC` / `Too many open files`** - WiredTiger opens a file per collection and index and needs a high open-files limit; Docker's default (1024) is far below MongoDB's documented minimum. The bundled `mongo` service raises `nofile` to 64000 via `ulimits`. If you've customized the compose file or run mongo outside it, set that limit yourself, then wipe the half-initialized volume and restart: `docker compose -f compose.selfhost.yaml --env-file .env.selfhost down -v && ... up -d`.
- **App can't reach Mongo / "no primary" errors** - MongoDB must run as a replica set (`--replSet rs0`) for transactions; the bundled `mongo` service is configured for this. Give it a few seconds to elect a primary on first boot.
- **No sign-in email arrives** - check Mailpit at `http://localhost:8025`; if it's empty, check `docker compose -f compose.selfhost.yaml logs app` for mail errors and verify the `MAIL_*` values.
- **A model returns "unauthorized"** - that provider's API key is missing or wrong in `.env.selfhost`. Only the providers you set keys for are available.
- **The model picker is empty / "no models" warning** - no provider key is configured. Set at least one provider key in `.env.selfhost` and restart (`docker compose -f compose.selfhost.yaml --env-file .env.selfhost up -d`), or add a key in the app under Settings > API Keys.
- **Chat replies only appear after a refresh** - expected for now: the realtime websocket gateway is not part of the compose stack yet, so live streaming updates degrade to fetch-on-refresh.
- **Changed `SECRET_ENCRYPTION_KEY` and now secrets fail to decrypt** - restore the original key; it cannot be rotated in place.

## Security notes

The stack is configured for **local, single-host use**: the backing services (Mongo, MinIO, ElasticMQ, Mailpit) run without authentication and bind to `127.0.0.1` only. Before running on a public-facing server you must enable Mongo auth, change the MinIO credentials, use a real SMTP provider, and put the app behind a reverse proxy with TLS. See the header of `compose.selfhost.yaml`.

## What you get (and don't)

Self-host runs the open-core engine - notebooks, multi-LLM chat, agents, the Quest Master, the knowledge engine, and artifacts. Known gaps today:

- **Realtime streaming** - the websocket gateway is not in the stack yet; chat replies and live updates appear on refresh.
- **Background enrichment** - features that ride the hosted event bus (notebook auto-naming, summaries, tagging) are inert in self-host for now.
- **Hosted-service features** - billing, entitlements, and premium overlays are not part of the open core; see the [open/closed boundary](./CONTRIBUTING.md#the-openclosed-boundary).

Need help? Ask in [Discussions](https://github.com/bike4mind/bike4mind/discussions).
