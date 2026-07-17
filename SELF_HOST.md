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

**No API keys? Run local models instead.** You can skip every provider key and run open-weight models (Qwen, Llama, etc.) locally via Ollama, with nothing leaving your machine. See [Local models with Ollama](#local-models-with-ollama-no-api-keys) below.

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

### Rebuild after local code changes

Working from a checkout and want to run your own edits (or a freshly pulled `main`) instead of the published image? Build from your working tree and recreate the app in one step:

```bash
docker compose -f compose.selfhost.yaml --env-file .env.selfhost --profile ollama up -d --build
```

`--build` rebuilds the `app` image from the Dockerfile before starting; only `app` rebuilds, the backing services just restart. Drop `--profile ollama` if you are not running local models. Thanks to the pnpm store cache mount and Docker layer caching, a warm rebuild (only app source changed, deps unchanged) takes about 1-2 minutes; a cold first build takes several.

Confirm it came up, then follow the logs:

```bash
docker compose -f compose.selfhost.yaml ps                      # services Up / healthy
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000         # expect 200
docker compose -f compose.selfhost.yaml logs -f app             # follow app logs (Ctrl-C to stop)
```

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

## Streaming completions API (`/api/ai/v1/completions`)

`POST /api/chat` (above) is the high-level chat API. For a low-level streaming completion - one request in, a token-by-token Server-Sent Events (SSE) stream out - call `/api/ai/v1/completions`. This is the endpoint the CLI uses under the hood, and the one to target from a custom client or agent loop.

On self-host it is served by the **`chatcompletion` container**, not the `app` container: reach it at `http://localhost:8788` by default (override the host port with `CHATCOMPLETION_HOST_PORT`, and advertise the external origin via `CHAT_COMPLETION_PUBLIC_URL`).

**Request** - OpenAI-shaped JSON:

- `model` (**required**) - a model id from `GET /api/models`. Unlike `/api/chat`, this endpoint has **no server-side default**; omit it and the request is rejected.
- `messages` (**required**) - `[{ "role": "user" | "assistant" | "system", "content": "..." }]`.
- Optional: `temperature`, `max_tokens`, `tools`, `response_format`, `stream`.

Authenticate with any one of: `x-api-key: b4m_...`, `Authorization: ApiKey b4m_...`, or `Authorization: Bearer <JWT>`.

**Response** - a **custom SSE contract, not OpenAI's**: there is no `choices[].delta`. Each frame is either an SSE comment (a line starting with `:`) or a `data:` line carrying one JSON object, and every frame ends with a blank line (`\n\n`). In order:

1. `: keep-alive` - an SSE comment sent immediately and then roughly every 10s so an intermediary does not drop an idle stream. EventSource ignores comment lines; a raw reader should skip any line starting with `:`.
2. `data: {"type":"meta","requestId":"..."}` - always the first JSON event; use `requestId` to correlate with server logs.
3. `data: {"type":"content","text":"...","usage":{...}}` - zero or more content chunks. `text` is the incremental output; `usage`, when present, carries `inputTokens`/`outputTokens` (and Anthropic cache-token deltas).
4. `data: {"type":"tool_use","text":"...","tools":[...]}` - sent instead of `content` for a chunk in which the model invoked a tool.
5. `data: {"type":"error","message":"...","requestId":"..."}` - on failure (invalid body, auth failure, or a mid-stream error); the stream then ends.
6. `data: [DONE]` - terminal sentinel on success.

**Example** - a local Ollama model (`-N` disables curl buffering so the stream prints live):

```bash
curl -N -X POST http://localhost:8788/api/ai/v1/completions \
  -H "x-api-key: $B4M_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "qwen2.5-coder:7b",
    "messages": [{ "role": "user", "content": "Say hello in five words." }]
  }'
```

Sample transcript:

```
: keep-alive

data: {"type":"meta","requestId":"1a2b3c4d"}

data: {"type":"content","text":"Hello"}

data: {"type":"content","text":" there, good"}

data: {"type":"content","text":" to meet you","usage":{"inputTokens":13,"outputTokens":5}}

data: [DONE]
```

## Drive it with the CLI (`b4m`)

Prefer the terminal? The [Bike4Mind CLI](./BIKE4MIND_CLI.md) talks to your self-hosted stack directly — the OAuth device-flow and chat APIs ship in the open core, so no hosted account or credits are involved.

```bash
npm install -g @bike4mind/cli        # requires Node.js 24+
b4m --api-url http://localhost:3000  # point it at your stack (use your APP_HOST_PORT if remapped)
b4m                                  # start, then /login — read the sign-in code from Mailpit at :8025
```

Auth is cached per environment, so you can keep a separate hosted login and switch with `--prod` / `--api-url`. Full guide (hosted **and** self-host, switching, troubleshooting): [**BIKE4MIND_CLI.md**](./BIKE4MIND_CLI.md).

## Local models with Ollama (no API keys)

Run open-weight models (Qwen, Llama, etc.) on your own hardware with **no provider API keys** and, once a model is pulled, **no internet**. Local models appear in the model picker under a **Local / Self-Hosted** section and work in chat like any other model.

The stack bundles an optional `ollama` service. To enable it:

1. In `.env.selfhost`, uncomment `OLLAMA_BASE_URL` and pick your model(s) in `OLLAMA_PULL_MODELS`:

   ```bash
   OLLAMA_BASE_URL=http://ollama:11434
   OLLAMA_PULL_MODELS=qwen2.5-coder:7b
   ```

2. Bring the stack up with the `ollama` profile (this also downloads the model on first run):

   ```bash
   docker compose -f compose.selfhost.yaml --env-file .env.selfhost --profile ollama up -d
   ```

That's it - open the model picker and select your model under **Local / Self-Hosted**. No keys, no admin settings to flip.

### Choosing a model (Qwen menu + hardware)

Pick by the hardware you have. "Min GPU VRAM" is what it takes to run fully on a GPU; with less, it still runs but spills to CPU RAM (slower). "CPU-only RAM" is what it needs with no GPU at all. Qwen2.5-Coder is tuned for coding; qwen3 is a newer general model.

| Model tag | Download | Min GPU VRAM | CPU-only RAM | Notes |
|-----------|---------:|-------------:|-------------:|-------|
| `qwen2.5-coder:1.5b` | ~1.0 GB | ~2 GB | ~8 GB | Tiny; fast even on CPU |
| `qwen2.5-coder:3b` | ~2.0 GB | ~4 GB | ~8 GB | Good on small / laptop GPUs |
| `qwen2.5-coder:7b` | ~4.7 GB | ~6-8 GB | ~16 GB | Recommended default |
| `qwen2.5-coder:14b` | ~9 GB | ~12 GB | ~32 GB | Stronger; needs a real GPU |
| `qwen2.5-coder:32b` | ~20 GB | ~24 GB | ~64 GB | Best local coder |
| `qwen3:8b` | ~5 GB | ~8 GB | ~16 GB | General-purpose alternative |

Set one or more (space-separated) in `OLLAMA_PULL_MODELS`, e.g. `OLLAMA_PULL_MODELS=qwen2.5-coder:3b qwen2.5-coder:7b`. Re-running `up` pulls any new ones and skips already-present models. To pull one ad hoc without editing the env: `docker compose -f compose.selfhost.yaml exec ollama ollama pull qwen2.5-coder:14b`. No GPU? Everything runs on CPU - start with a 1.5b or 3b model.

### GPU acceleration (NVIDIA)

The bundled `ollama` service runs on CPU by default so it works on any host. To use an NVIDIA GPU, install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) so Docker can pass the GPU into containers, then add the GPU override file.

Install the toolkit (Debian/Ubuntu; needs sudo and internet). This adds NVIDIA's apt repo first, which is why a plain `apt-get install nvidia-container-toolkit` fails with "Unable to locate package" on a machine that hasn't set it up:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verify Docker can see the GPU:

```bash
docker info | grep -i Runtimes                    # should list "nvidia"
docker run --rm --gpus all ubuntu nvidia-smi -L   # should print your GPU
```

Then bring the stack up with the GPU override added as a second `-f`:

```bash
docker compose -f compose.selfhost.yaml -f compose.ollama-gpu.yaml --env-file .env.selfhost --profile ollama up -d
```

The GPU needs enough free VRAM for your chosen model (see the table above); Ollama offloads as many layers as fit and runs the rest on CPU.

### Using an Ollama you already run

Already run Ollama on the host (e.g. a native GPU install)? Skip the `ollama` profile entirely and point the app at it:

```bash
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

## Troubleshooting

- **`docker pull` fails with `unauthorized` / `manifest unknown`** - the prebuilt image isn't available to your account (or isn't published yet). Build it from source instead - see "Building from source" in step 3.
- **`Error ... address already in use` / `failed to bind host port`** - another process on your host already owns one of the published ports (a local `mongod` on 27017 is the common one; also 3000, 9000, 9001, 9324, 9325, 8025). Override just the host side with the matching `*_HOST_PORT` var in `.env.selfhost` (e.g. `MONGO_HOST_PORT=27018`) - the services still reach each other over the compose network on their fixed internal ports, so nothing else needs to change.
- **MongoDB crashes on first boot with `WT_PANIC` / `Too many open files`** - WiredTiger opens a file per collection and index and needs a high open-files limit; Docker's default (1024) is far below MongoDB's documented minimum. The bundled `mongo` service raises `nofile` to 64000 via `ulimits`. If you've customized the compose file or run mongo outside it, set that limit yourself, then wipe the half-initialized volume and restart: `docker compose -f compose.selfhost.yaml --env-file .env.selfhost down -v && ... up -d`.
- **App can't reach Mongo / "no primary" errors** - MongoDB must run as a replica set (`--replSet rs0`) for transactions; the bundled `mongo` service is configured for this. Give it a few seconds to elect a primary on first boot.
- **No sign-in email arrives** - check Mailpit at `http://localhost:8025`; if it's empty, check `docker compose -f compose.selfhost.yaml logs app` for mail errors and verify the `MAIL_*` values.
- **A model returns "unauthorized"** - that provider's API key is missing or wrong in `.env.selfhost`. Only the providers you set keys for are available.
- **The model picker is empty / "no models" warning** - no provider key is configured and no local Ollama is set up. Set at least one provider key in `.env.selfhost`, or enable local models (see "Local models with Ollama"), then restart with `docker compose -f compose.selfhost.yaml --env-file .env.selfhost up -d`.
- **Local models don't appear under "Local / Self-Hosted"** - make sure you started the stack with `--profile ollama` and that `OLLAMA_BASE_URL` is uncommented in `.env.selfhost`. Confirm the model pulled: `docker compose -f compose.selfhost.yaml exec ollama ollama list`. The picker caches models for ~60s after a pull.
- **Local model replies are slow** - with no GPU, inference runs on CPU; start with a small model (`qwen2.5-coder:1.5b` or `:3b`). For NVIDIA GPU acceleration, add `-f compose.ollama-gpu.yaml` (see that section).
- **`apt-get install nvidia-container-toolkit` says "Unable to locate package"** - NVIDIA's apt repo isn't set up. Add it first (see "GPU acceleration"), then re-run `sudo apt-get update`.
- **GPU override fails with "could not select device driver \"nvidia\" with capabilities: [[gpu]]"** - the NVIDIA Container Toolkit isn't installed or wired into Docker. Install it and run `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker` (see "GPU acceleration"). Without a working GPU runtime, drop the `-f compose.ollama-gpu.yaml` and run CPU-only.
- **Chat replies only appear after a refresh** - realtime isn't connecting. Check the `ws` gateway is up (`docker compose -f compose.selfhost.yaml ps ws`) and healthy, that `INTERNAL_WS_SECRET` is set and identical for the `app` and `ws` services, and that `WEBSOCKET_URL`/`WEBSOCKET_MANAGEMENT_ENDPOINT` point at the gateway. In the browser console you should see `ws connected`; a reconnect loop usually means the gateway can't reach the app (`docker compose -f compose.selfhost.yaml logs ws`).
- **Changed `SECRET_ENCRYPTION_KEY` and now secrets fail to decrypt** - restore the original key; it cannot be rotated in place.

## Security notes

The stack is configured for **local, single-host use**: the backing services (Mongo, MinIO, ElasticMQ, Mailpit) run without authentication and bind to `127.0.0.1` only. Before running on a public-facing server you must enable Mongo auth, change the MinIO credentials, use a real SMTP provider, and put the app behind a reverse proxy with TLS. See the header of `compose.selfhost.yaml`.

## What you get (and don't)

Self-host runs the open-core engine - notebooks, multi-LLM chat, agents, the Quest Master, the knowledge engine, and artifacts. It includes **realtime streaming**: the `ws` gateway + `subscriber-fanout` services stream chat replies token-by-token and push live document updates (notebooks, sync) without a page refresh - the same WebSocket experience as the hosted app, with no AWS API Gateway. Known gaps today:

- **Background enrichment** - features that ride the hosted event bus (notebook auto-naming, summaries, tagging) are inert in self-host for now.
- **Hosted-service features** - billing, entitlements, and premium overlays are not part of the open core; see the [open/closed boundary](./CONTRIBUTING.md#the-openclosed-boundary).
- **Python artifacts need internet** - the in-browser Python runtime (Pyodide) is fetched from a public CDN, so running a Python artifact needs internet unless you point `PYODIDE_BASE_URL` at a local mirror (see below).

### Python artifacts offline

Python artifacts execute in the browser via Pyodide (WebAssembly), fetched by default from the public jsDelivr CDN - so a fully air-gapped box cannot run them out of the box. To run them offline, mirror the Pyodide v0.25.1 "full" distribution on a server you control and set `PYODIDE_BASE_URL` in `.env.selfhost` to that base (trailing slash required). A cross-origin mirror must send permissive CORS headers; its origin is added to the app CSP automatically. See the `PYODIDE_BASE_URL` block in `.env.selfhost.example` for what to mirror. Leave it unset to use the CDN.

Need help? Ask in [Discussions](https://github.com/bike4mind/bike4mind/discussions).
