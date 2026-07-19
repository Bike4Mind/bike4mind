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
- `messages` (**required**) - `[{ "role": "user" | "assistant" | "system", "content": "..." }]`. `content` is a string or an array of content parts.
- Optional: `temperature`, `max_tokens`, `tools`, `response_format`, `stream`. `tools` is **not** OpenAI-shaped - each entry is `{ toolSchema: { name, description, parameters } }` (see `CompletionToolSchema` in `b4m-core/common/src/schemas/cliCompletions.ts`), not `{ type: "function", function: {...} }`.

Authenticate with any one of: `x-api-key: b4m_...`, `Authorization: ApiKey b4m_...`, or `Authorization: Bearer <JWT>`.

**Response** - a **custom SSE contract, not OpenAI's**: there is no `choices[].delta`. Each frame is either an SSE comment (a line starting with `:`) or a `data:` line carrying one JSON object, and every frame ends with a blank line (`\n\n`). The stream opens and closes in the order below, but the middle is a stream: `content` and `tool_use` frames interleave one per chunk (a tool-calling turn emits `tool_use` frames among the `content` ones), and keep-alive comments keep recurring (about every 10s) throughout:

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

Want other MCP clients (Claude Desktop, editors) to drive your stack? Run `b4m mcp serve` to expose it as an MCP server - see [Serve Bike4Mind as an MCP server](./BIKE4MIND_CLI.md#serve-bike4mind-as-an-mcp-server-b4m-mcp-serve).

## Local models with Ollama (no API keys)

Run open-weight models (Qwen, Llama, etc.) on your own hardware with **no provider API keys** and, once a model is pulled, **no internet**. Local models appear in the model picker under a **Local / Self-Hosted** section and work in chat like any other model.

The stack bundles an optional `ollama` service. To enable it:

1. In `.env.selfhost`, uncomment `OLLAMA_BASE_URL` and pick your model(s) in `OLLAMA_PULL_MODELS`:

   ```bash
   OLLAMA_BASE_URL=http://ollama:11434
   # Chat model + an embedder so offline file search works out of the box:
   OLLAMA_PULL_MODELS=qwen2.5-coder:7b nomic-embed-text
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

## Local web search (no SerpAPI key)

The `web_search` tool (and `deep_research`) can run against a self-hosted [SearXNG](https://docs.searxng.org/) metasearch engine instead of the paid SerpAPI, so search works with **no external search key**. The stack bundles an optional `searxng` service.

1. In `.env.selfhost`, uncomment `SEARXNG_BASE_URL`:

   ```bash
   SEARXNG_BASE_URL=http://searxng:8080
   ```

2. Bring the stack up with the `search` profile:

   ```bash
   docker compose -f compose.selfhost.yaml --env-file .env.selfhost --profile search up -d
   ```

Enable the **Web Search** tool in the composer and it will use SearXNG automatically. Provider selection follows the `WebSearchProvider` admin setting (default `auto`): `auto` prefers SearXNG when a URL is configured and otherwise falls back to a SerpAPI key (`SerperKey` in Admin > API Keys); set it to `serpapi` or `searxng` to force one. The SearXNG config lives in `selfhost/searxng/settings.yml` (mounted read-only) and its `secret_key` comes from `SEARXNG_SECRET` in `.env.selfhost` - no secret is committed to the repo.

### Reading pages: web_fetch and Firecrawl

The `web_fetch` tool (reading a specific URL) and `deep_research` (which extracts page content) use [Firecrawl](https://www.firecrawl.dev/) when it is configured - set `FIRECRAWL_API_URL` (a self-hosted Firecrawl instance, no key needed) and/or `FIRECRAWL_API_KEY` (hosted cloud) in `.env.selfhost`, or the equivalents in Admin > API Keys.

Without any Firecrawl config, `web_fetch` falls back to a **keyless direct fetch** that downloads the page and converts its HTML to markdown - so reading pages works out of the box with no key. That fallback has two limits versus Firecrawl: it does not run JavaScript (heavily client-rendered pages may come back sparse) and it cannot parse PDFs (upload a PDF directly instead). `deep_research` likewise runs on just a web-search provider, using the same plain-fetch reader for extraction.

## Local image generation (no API keys)

Generate images on your own hardware with **no provider API keys**. The stack bundles an optional `imagegen` service (SD.Next) that exposes the AUTOMATIC1111-compatible REST API. When `IMAGE_GEN_BASE_URL` is set, its installed checkpoints appear in the image model picker automatically (as `local-image/<checkpoint>`) and work in chat like any other image model. This is the image counterpart to local models with Ollama.

To enable it:

1. In `.env.selfhost`, uncomment `IMAGE_GEN_BASE_URL` and pick your checkpoint in `IMAGE_GEN_PULL_MODELS`:

   ```bash
   IMAGE_GEN_BASE_URL=http://imagegen:7860
   IMAGE_GEN_PULL_MODELS=https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors
   ```

2. Bring the stack up with the `imagegen` profile (this also downloads the checkpoint on first run):

   ```bash
   docker compose -f compose.selfhost.yaml --env-file .env.selfhost --profile imagegen up -d
   ```

Open the image model settings and pick your checkpoint. No keys, no admin settings to flip. The first checkpoint download is several GB; once it finishes, the puller triggers an SD.Next rescan automatically, so the checkpoint appears in the picker **within about a minute** (the app caches the model list for ~60s per user, so allow up to that TTL).

### Choosing a checkpoint (hardware)

Pick by the hardware you have. "Min GPU VRAM" is what it takes to run comfortably on a GPU; with less, it still runs but spills to CPU RAM (slower). "CPU-only RAM" is what it needs with no GPU at all.

| Checkpoint | Download | Min GPU VRAM | CPU-only RAM | License |
|------------|---------:|-------------:|-------------:|---------|
| SD 1.5 (default) | ~4.0 GB | ~4 GB | ~8 GB | CreativeML OpenRAIL-M |
| SDXL base 1.0 | ~6.9 GB | ~10-12 GB | ~16 GB | CreativeML Open RAIL++-M |

Set one or more (space-separated) `.safetensors` URLs from a public host in `IMAGE_GEN_PULL_MODELS`. Re-running `up` downloads any new ones and skips already-present files. Any A1111-compatible checkpoint URL works. No GPU? Start with SD 1.5.

### Performance (CPU vs GPU)

The bundled `imagegen` service runs **CPU-only by default** so it works on any host - but Stable Diffusion is compute-heavy, so expect roughly **1-3 minutes per image** at 512x512 / 20 steps on CPU. On a GPU with ~4 GB+ free VRAM the same image is about **5-15 seconds**, so a **GPU is strongly recommended for interactive use** - CPU is fine for the occasional image but too slow to sit and wait on in a chat.

The **first generation after a fresh bring-up is slower still**: the checkpoint has to be loaded into memory before any image can render, which itself takes minutes on CPU. The puller preloads the first checkpoint right after downloading it, so by the time you generate it is usually already loaded; if it isn't (or you switch checkpoints), the app loads it on demand and the first request pays that one-time load cost on top of the render.

For NVIDIA GPU acceleration, install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) (see the same steps under "GPU acceleration (NVIDIA)" above), then add the GPU override file as a second `-f`:

```bash
docker compose -f compose.selfhost.yaml -f compose.imagegen-gpu.yaml --env-file .env.selfhost --profile imagegen up -d
```

The GPU override drops the CPU flag so SD.Next uses CUDA; the GPU needs enough free VRAM for your checkpoint (see the table above).

### Using an SD server you already run

Already run an A1111 / SD.Next server on the host? Skip the `imagegen` profile entirely and point the app at it:

```bash
IMAGE_GEN_BASE_URL=http://host.docker.internal:7860
```

### Pinning the image versions (reproducibility)

The bundled `imagegen` (`vladmandic/sdnext-cuda`) and `imagegen-pull` (`curlimages/curl`) services ship with floating `:latest` tags for convenience. `:latest` is not reproducible - a later upstream push can change the image under you between deploys. For a stable stack, pin a concrete version yourself. The `imagegen` image is env-overridable; set a specific tag or (best) an immutable digest in `.env.selfhost`:

```bash
IMAGEGEN_IMAGE=vladmandic/sdnext-cuda@sha256:<digest>
```

Resolve a digest for a tag you have pulled with `docker image inspect <image> --format '{{index .RepoDigests 0}}'`. The `imagegen-pull` image is not env-overridable; edit `compose.selfhost.yaml` directly if you need to pin it too. We intentionally do not ship a hard-coded pin here because the right tag/digest depends on your platform (CPU vs GPU) and drifts over time - and a wrong pin would break the stack.

## Offline RAG (file search / knowledge base)

Self-host can embed and search your uploaded files fully offline, using a local Ollama embedder - no OpenAI/Voyage key required. To turn it on:

1. **Pull an embedder.** The default `OLLAMA_PULL_MODELS` already includes `nomic-embed-text`; if you customized it, add an embedder tag (see the embedder table in `.env.selfhost.example`) and re-run `up`.
2. **Set the embedding model.** In the app, go to **Settings -> AI -> Default Embedding Model** and pick your pulled embedder (e.g. `nomic-embed-text`). The Ollama embedders only appear in this list in self-host.
3. **Leave auto-chunk on.** The **Enable Auto Chunk** admin setting (on by default in self-host) makes uploads chunk + embed automatically.
4. **Upload a file**, then watch its chunk/vector counts climb (the file card shows progress). Behind the scenes: MinIO notifies the app on upload -> the file is chunked -> chunks are embedded by the `worker` service.
5. **Ask a knowledge-base question** in chat, or use file search - retrieval now runs against the local embeddings.

Notes:

- **Dimensions / re-indexing.** Each embedding model has its own vector dimensions (e.g. `nomic-embed-text` = 768, OpenAI = 1536). If you change the Default Embedding Model, previously embedded files stay on their old dimensions and are simply skipped in search until re-processed - re-embed them via **/api/files/reprocess** (or re-upload). Mixed dimensions never error; they just don't match.
- **Small GPUs (4 GB).** The embedder is unloaded promptly after each call (`OLLAMA_EMBED_KEEP_ALIVE` defaults to `0`) so it doesn't pin VRAM alongside your chat model. Raise it (e.g. `5m`) if you embed constantly and have VRAM to spare.

## Background worker

The `worker` service is the self-host replacement for the hosted background infrastructure (SST queue consumers + cron). It runs no HTTP server and publishes no ports; it just:

- **consumes queues** - research tasks, and the RAG ingestion pipeline (`fabFileChunkQueue` -> `fabFileVectorizeQueue`);
- **consumes enrichment events** - memento creation, session auto-naming, summaries, and tagging, delivered via `SELF_HOST_EVENT_QUEUE`;
- **runs the scheduler** - the task scheduler (research follow-ups) every 5 minutes, plus a safety-net scan that re-enqueues any uploaded file whose chunking never started.

It comes up automatically with the stack. To watch it:

```bash
docker compose -f compose.selfhost.yaml --env-file .env.selfhost logs -f worker
```

The worker reuses the chatCompletion image and connects to Mongo, ElasticMQ, MinIO, and (for embedding) Ollama using the same `.env.selfhost` values as the other services.

> **Run a single `worker` replica.** The scheduler and safety-net scan are not leader-guarded, so scaling `worker` to multiple replicas would double-run them (duplicate scheduled tasks and duplicate chunk enqueues). Queue consumers are safe to scale, but the bundled compose runs one `worker`; keep it that way.

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
- **Local image checkpoint doesn't show in the picker** - make sure you started the stack with `--profile imagegen` and that `IMAGE_GEN_BASE_URL` is uncommented in `.env.selfhost`. The checkpoint download is several GB; watch it with `docker compose -f compose.selfhost.yaml logs imagegen-pull` and confirm the file landed with `docker compose -f compose.selfhost.yaml exec imagegen ls /mnt/models/Stable-diffusion`. The puller triggers an SD.Next rescan once the download finishes, and the picker caches models for ~60s. If it still isn't listed, force a rescan from the host: `curl -X POST http://127.0.0.1:7860/sdapi/v1/refresh-checkpoints`.
- **Image generation is very slow** - with no GPU, Stable Diffusion runs on CPU (~1-3 min/image). Start with SD 1.5, and for NVIDIA GPU acceleration add `-f compose.imagegen-gpu.yaml` (see "Local image generation").
- **`apt-get install nvidia-container-toolkit` says "Unable to locate package"** - NVIDIA's apt repo isn't set up. Add it first (see "GPU acceleration"), then re-run `sudo apt-get update`.
- **GPU override fails with "could not select device driver \"nvidia\" with capabilities: [[gpu]]"** - the NVIDIA Container Toolkit isn't installed or wired into Docker. Install it and run `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker` (see "GPU acceleration"). Without a working GPU runtime, drop the `-f compose.ollama-gpu.yaml` and run CPU-only.
- **Chat replies only appear after a refresh** - realtime isn't connecting. Check the `ws` gateway is up (`docker compose -f compose.selfhost.yaml ps ws`) and healthy, that `INTERNAL_WS_SECRET` is set and identical for the `app` and `ws` services, and that `WEBSOCKET_URL`/`WEBSOCKET_MANAGEMENT_ENDPOINT` point at the gateway. In the browser console you should see `ws connected`; a reconnect loop usually means the gateway can't reach the app (`docker compose -f compose.selfhost.yaml logs ws`).
- **Changed `SECRET_ENCRYPTION_KEY` and now secrets fail to decrypt** - restore the original key; it cannot be rotated in place.
- **Notebook auto-naming / summaries / mementos never happen** - background enrichment runs on the `worker` service via the event queue. Check the worker is up (`docker compose -f compose.selfhost.yaml ps worker`) and that `SELF_HOST_EVENT_QUEUE` is set in `.env.selfhost` (the app warns and drops enrichment events when it's unset). Watch `docker compose -f compose.selfhost.yaml logs -f worker`.
- **Research/deep-research tasks never complete** - the `worker` consumes the research queue. Confirm it's running and check its logs; a task that keeps failing is left for a few retries, then dropped with an error log (ElasticMQ has no dead-letter queue).
- **Uploaded files never chunk or become searchable** - ingestion is triggered by a MinIO -> app webhook. Verify `INTERNAL_S3_WEBHOOK_SECRET` is set (identical value reaches both the `app` and `minio` services via `.env.selfhost`), that `createbuckets` ran the `mc event add` on the fab-file bucket (`docker compose -f compose.selfhost.yaml logs createbuckets`), and that a local embedder is configured (see "Offline RAG"). Even if the webhook is missed, the worker's 60s safety-net scan re-enqueues un-chunked files - so also check the `worker` logs.

## Security notes

The stack is configured for **local, single-host use**: the backing services (Mongo, MinIO, ElasticMQ, Mailpit) run without authentication and bind to `127.0.0.1` only. Before running on a public-facing server you must enable Mongo auth, change the MinIO credentials, use a real SMTP provider, and put the app behind a reverse proxy with TLS. See the header of `compose.selfhost.yaml`.

When you put the app behind a reverse proxy, forward the original `Host` header and set `X-Forwarded-Proto` (e.g. `https` once TLS is terminated at the proxy). The published-artifact viewer derives each page's Content-Security-Policy origin and scheme from those headers, so getting them right is what lets published artifact bundles load their assets over your real origin.

Publishing stages each bundle under a temporary `drafts/` prefix in the artifacts bucket and promotes it on finalize; a finalized publish deletes its own draft. The `createbuckets` one-shot sets a MinIO lifecycle rule that expires anything left under `drafts/` after 7 days, so abandoned or failed publishes do not accumulate. If you point object storage at a different S3 backend, add an equivalent lifecycle rule (or a periodic cleanup) on the `drafts/` prefix yourself - only the bundled MinIO gets the rule automatically.

## What you get (and don't)

Self-host runs the open-core engine - notebooks, multi-LLM chat, agents, the Quest Master, the knowledge engine, and artifacts (including publishing and sharing artifact bundles - uploads proxy through the app, so MinIO stays internal). It includes **realtime streaming**: the `ws` gateway + `subscriber-fanout` services stream chat replies token-by-token and push live document updates (notebooks, sync) without a page refresh - the same WebSocket experience as the hosted app, with no AWS API Gateway. It also includes **background enrichment and offline RAG**: the `worker` service runs the queue consumers and scheduler, so notebook auto-naming, summaries, tagging, memento creation, research tasks, and automatic file chunking + embedding all work (embeddings can run fully offline via a local Ollama embedder - see "Offline RAG"). Known gaps today:

- **Image moderation on upload** - the hosted upload path runs AWS Rekognition; self-host skips it (no AWS), so uploaded images are not content-scanned.
- **Hosted-service features** - billing, entitlements, and premium overlays are not part of the open core; see the [open/closed boundary](./CONTRIBUTING.md#the-openclosed-boundary).
- **Python artifacts need internet** - the in-browser Python runtime (Pyodide) is fetched from a public CDN, so running a Python artifact needs internet unless you point `PYODIDE_BASE_URL` at a local mirror (see below).

### Python artifacts offline

Python artifacts execute in the browser via Pyodide (WebAssembly), fetched by default from the public jsDelivr CDN - so a fully air-gapped box cannot run them out of the box. To run them offline, mirror the Pyodide v0.25.1 "full" distribution on a server you control and set `PYODIDE_BASE_URL` in `.env.selfhost` to that base (a trailing slash is added automatically if you omit it). A cross-origin mirror must send permissive CORS headers; its origin is added to the app CSP automatically. See the `PYODIDE_BASE_URL` block in `.env.selfhost.example` for what to mirror. Leave it unset to use the CDN.

Need help? Ask in [Discussions](https://github.com/bike4mind/bike4mind/discussions).
