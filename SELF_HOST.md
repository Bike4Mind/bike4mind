# Self-Host Quickstart

Run the open core of Bike4Mind on your own hardware — a laptop, a server, or your own cloud — with **no AWS account or hyperscaler required**. This is "Path B": the app plus its dependencies (MongoDB, object storage, and a queue) run as local containers via Docker Compose.

> **Status:** the self-host container stack is being finalized (`#9313`). The app image and env reference are published; the full Compose stack (object storage + queues + realtime gateway) is landing incrementally. Check the repo's `compose.yaml` for the services currently wired.

## Prerequisites

- **Docker** and **Docker Compose** (Docker Desktop, or Docker Engine + the compose plugin).
- ~4 GB free RAM for the stack.
- API keys for whichever LLM providers you want to use (Anthropic, OpenAI, Google Gemini, xAI, or a local Ollama endpoint).

You do **not** need Node, pnpm, or a local build — the app ships as a prebuilt image at `ghcr.io/bike4mind/bike4mind-selfhost` (multi-arch: amd64 + arm64). If you'd rather build from source, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## 1. Get the compose files

Clone the repo (or copy `compose.yaml` and `.env.selfhost.example` from it):

```bash
git clone https://github.com/bike4mind/bike4mind.git
cd bike4mind
```

## 2. Configure your environment

Copy the template and fill it in. It's auto-derived from the `@bike4mind/resource` config manifest, so it lists every variable the app reads:

```bash
cp .env.selfhost.example .env
```

**Generate the three security secrets** (each a fresh 32-byte hex string):

```bash
openssl rand -hex 32   # → JWT_SECRET
openssl rand -hex 32   # → SESSION_SECRET
openssl rand -hex 32   # → SECRET_ENCRYPTION_KEY
```

> ⚠️ **Never change `SECRET_ENCRYPTION_KEY` after first boot.** It encrypts other secrets stored in the database — rotating it makes existing encrypted data unreadable.

**Minimum required to boot:**

| Variable | What it is | Example |
|---|---|---|
| `B4M_SELF_HOST` | Enables the self-host (no-AWS) build path | `true` |
| `APP_NAME` | App identifier | `bike4mind` |
| `APP_STAGE` | Deployment stage label | `selfhost` |
| `MONGODB_URI` | MongoDB connection (replica set required) | `mongodb://mongo:27017/bike4mind?replicaSet=rs0` |
| `JWT_SECRET` | Auth token signing key | *(openssl above)* |
| `SESSION_SECRET` | Session signing key | *(openssl above)* |
| `SECRET_ENCRYPTION_KEY` | DB secret encryption key | *(openssl above)* |
| `WEBSOCKET_URL` | Realtime endpoint the browser connects to | `ws://localhost:3001` |
| `WEBSOCKET_MANAGEMENT_ENDPOINT` | Server-side realtime endpoint | `http://ws:3001` |

The object-storage buckets and queues are pre-filled in `.env.selfhost.example` to point at the bundled MinIO and queue services — leave them as-is unless you're wiring your own S3/SQS.

**LLM & integration keys** — set the ones you'll use; blank disables that integration:

```bash
ANTHROPIC_API_KEY=      # Claude
OPENAI_API_KEY=         # GPT / DALL·E
GEMINI_API_KEY=         # Google Gemini
# ...plus optional GitHub/Google OAuth, Stripe, mail, Slack — see the template
```

## 3. Bring up the stack

```bash
docker compose up
```

This pulls the app image and starts it alongside MongoDB (and, as they land, object storage and the queue/realtime services). When it's healthy, open:

```
http://localhost:3000
```

## Troubleshooting

- **App can't reach Mongo / "no primary" errors** — MongoDB must run as a replica set (`--replSet rs0`) for transactions; the bundled `db` service is configured for this. Give it a few seconds to elect a primary on first boot.
- **A model returns "unauthorized"** — that provider's API key is missing or wrong in `.env`. Only the providers you set keys for are available.
- **Realtime features hang** — check `WEBSOCKET_URL` (browser-facing) and `WEBSOCKET_MANAGEMENT_ENDPOINT` (server-facing) match your setup.
- **Changed `SECRET_ENCRYPTION_KEY` and now secrets fail to decrypt** — restore the original key; it cannot be rotated in place.

## What you get (and don't)

Self-host runs the open-core engine — notebooks, multi-LLM chat, agents, the Quest Master, the knowledge engine, and artifacts. The multi-tenant hosted-service features (billing, entitlements) and premium overlays are not part of the open core; see the [open/closed boundary](./CONTRIBUTING.md#the-openclosed-boundary).

Need help? Ask in [Discussions](https://github.com/bike4mind/bike4mind/discussions).
