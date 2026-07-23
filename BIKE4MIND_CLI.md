# Bike4Mind CLI (`b4m`)

`b4m` is an interactive, terminal-based agent for Bike4Mind — chat, ReAct tool use, MCP integration, and session persistence, all from your shell. It can talk to **either** the hosted Bike4Mind service (using your account and purchased credits) **or** your own [self-hosted stack](./SELF_HOST.md) — you choose per environment and switch freely.

This is the task-oriented guide. For the exhaustive flag/command reference and the contributor workflow, see [`packages/cli/README.md`](./packages/cli/README.md).

## Contents

- [Install](#install)
- [Which backend am I talking to?](#which-backend-am-i-talking-to)
- [Using the hosted service (and your credits)](#using-the-hosted-service-and-your-credits)
- [Using your self-hosted stack](#using-your-self-hosted-stack)
- [Pointing at any deployment (AWS, staging, …)](#pointing-at-any-deployment-aws-staging-)
- [Switching between environments](#switching-between-environments)
- [Tool API keys & MCP servers](#tool-api-keys--mcp-servers)
- [Serve Bike4Mind as an MCP server (`b4m mcp serve`)](#serve-bike4mind-as-an-mcp-server-b4m-mcp-serve)
- [Headless / scripting mode](#headless--scripting-mode)
- [Troubleshooting](#troubleshooting)

## Install

Requires **Node.js 24+**.

```bash
npm install -g @bike4mind/cli      # install the `b4m` (and `bike4mind`) command
# or run without installing:
npx @bike4mind/cli
```

Verify:

```bash
b4m --version
b4m doctor        # checks Node, npm registry, ripgrep, and native modules
```

Building the CLI from a checkout instead? See [Development](./packages/cli/README.md#development) in the package README.

## Which backend am I talking to?

The active backend is shown in the startup banner (`🌍 API Environment: …`) and via `/api-info` inside a session. The CLI resolves it in this order:

1. A **custom URL** you set with `--api-url` / `/set-api` (self-hosted or any deployment).
2. Otherwise, a **build-time default** baked into the published binary. The upstream `@bike4mind/cli` bakes the hosted service; an [open-core fork](./CONTRIBUTING.md#the-openclosed-boundary) that publishes its own CLI without setting `B4M_DEFAULT_API_URL` ships without one.
3. Otherwise, when running **from source** (a `pnpm link --global` checkout or `pnpm dev` — no `dist/` built), the CLI defaults to the local dev server `http://localhost:3001`, since that's almost always what a contributor wants. Use `--prod` / `--api-url` to change it.
4. Otherwise (a published, unbranded fork with no baked default), the first `b4m` **prompts you to pick a backend** (hosted / local dev / custom URL) before signing in.

Auth tokens are cached **per environment**, so pointing at a new backend prompts a one-time `/login`, and switching back later reuses the cached session.

## Using the hosted service (and your credits)

```bash
b4m --prod        # select the hosted Bike4Mind service (remembered)
b4m               # subsequent runs reuse the last environment
```

On first run you'll be prompted to sign in via the OAuth device flow:

1. Run `b4m` (or `/login`).
2. Open the verification URL shown in the terminal.
3. Enter the user code to authorize the CLI — tokens are stored in `~/.bike4mind/config.json` (mode `0600`).

Usage draws down your account's **credits**. Check your balance any time:

```
/usage
```

Buy or top up credits from your account on the hosted web app; the CLI links you there when a session runs out.

## Using your self-hosted stack

If you run the open core with the [self-host quickstart](./SELF_HOST.md), the OAuth device-flow and chat APIs are served by your own `app` container — so `b4m` works against it with **no hosted account and no credits**. Everything stays on your hardware.

Assuming the default self-host setup (app on `http://localhost:3000`):

```bash
# 1. Point the CLI at your stack (clears any cached auth, then exits)
b4m --api-url http://localhost:3000

# 2. Start the CLI and sign in
b4m
#    → run /login, open the verification URL, and approve it.
#    → the sign-in email is caught by Mailpit at http://localhost:8025
#      (self-host uses one-time email codes; nothing leaves your machine).

# 3. Chat as usual. Confirm the target any time with:
/api-info
```

Notes for the self-host path:

- **Port.** The Docker stack serves the app on `3000` by default (`--dev` is a *different* target — the dev server on `3001`). If you remapped the host port (`APP_HOST_PORT` in `.env.selfhost`), use that port in `--api-url`.
- **Models.** Only models for providers you configured a key for appear — or your local Ollama models. See [Local models with Ollama](./SELF_HOST.md#local-models-with-ollama-no-api-keys). To surface a host-native Ollama in the picker without editing config, launch with `b4m --ollama-host http://localhost:11434`.
- **Credits — you don't need them.** Self-host sets `B4M_SELF_HOST=true`, which defaults the **Enforce Credits** admin setting **off**, so usage is never metered: you don't grant yourself credits or top up (`/usage` just shows enforcement is disabled). Your only cost is your own LLM provider bill. An admin *can* turn on **Enforce Credits** (Admin → Settings → Credits) if you want to meter users on your instance.
- **Streaming.** The self-host stack includes the realtime WebSocket gateway (the `ws` and `subscriber-fanout` services), so chat replies stream token-by-token and live document updates arrive without a refresh - the same experience as the hosted app, with no AWS API Gateway. See [what you get](./SELF_HOST.md#what-you-get-and-dont).

## Pointing at any deployment (AWS, staging, …)

`--api-url` accepts any reachable Bike4Mind URL — a cloud deployment, a staging box, a teammate's tunnel:

```bash
b4m --api-url https://app.your-company.example.com
b4m --reset-api      # go back to the built-in default
```

## Switching between environments

| Action | Command |
| --- | --- |
| Hosted production | `b4m --prod` |
| Local dev server (`:3001`) | `b4m --dev` (alias `--local`) |
| Self-host / custom URL | `b4m --api-url <url>` or in-session `/set-api <url>` |
| Reset to default | `b4m --reset-api` or `/reset-api` |
| Show current target | `/api-info` |

Each environment keeps its **own cached login**, so hopping between your hosted account and your self-hosted stack does not force repeated re-authentication. A bare `b4m` always reopens whichever environment you last selected.

## Tool API keys & MCP servers

Some built-in tools (weather, web search, deep research) need provider keys, and you can attach MCP servers for extra capabilities. Both are configured in `~/.bike4mind/config.json` (or, for MCP, via `b4m mcp add …`). See:

- [Tool API keys](./packages/cli/README.md#tool-api-keys)
- [MCP servers](./packages/cli/README.md#optional-mcp-servers)

## Serve Bike4Mind as an MCP server (`b4m mcp serve`)

`b4m mcp serve` turns your Bike4Mind backend into a [Model Context Protocol](https://modelcontextprotocol.io) server, so any MCP client (Claude Desktop, editors, other agents) can drive your notebooks, chat, and files. This is the opposite direction from `b4m mcp add`, which attaches external MCP servers *into* the CLI.

### Tools and resources

| Tool | Does | Scope |
| --- | --- | --- |
| `list_notebooks` | List your notebooks (sessions) | `notebooks:read` |
| `get_notebook` | Fetch one notebook by id | `notebooks:read` |
| `create_notebook` | Create a notebook (optionally in a project) | `notebooks:write` |
| `send_message` | Send a chat message and wait for the reply | `ai:chat` |
| `search_knowledge_base` | Semantic search across your notebooks | `notebooks:read` |
| `list_files` | Search your files | `files:read` |
| `get_file` | File metadata plus a signed download URL | `files:read` |

It also exposes four resource templates, each with a working `list` and `read` that return `application/json`:

| Resource | Lists / reads | Scope |
| --- | --- | --- |
| `b4m://notebook/{id}` | Your notebooks (sessions) | `notebooks:read` |
| `b4m://file/{id}` | File metadata plus a signed download URL | `files:read` |
| `b4m://project/{id}` | Your projects | `projects:read` |
| `b4m://artifact/{id}` | Artifact metadata plus its current content | none (see below) |

Resource *listing* is capped at 100 entries per template and takes no paging arguments. A listing that fails (for example, a key without `projects:read`) degrades to an empty list for that template only, so the other three still enumerate. Because an empty list can therefore also mean an auth failure and not just an empty account, the underlying error is written to the server's stderr; under stdio transport your MCP host captures that stream (for example Claude Desktop's `~/Library/Logs/Claude/mcp-server-*.log`), so check it there if a resource picker comes back unexpectedly empty. There is no `artifacts:*` API-key scope, so an artifact 403 carries no scope recommendation.

The **Scope** column in both tables is the *recommended* key configuration for that tool or resource, not a per-route hard gate: most of these routes do not enforce scopes, so a real 403 can also mean a CASL authorization denial or a suspended account, not just a missing scope.

### Auth and endpoint

Listing tools needs no credentials; tool *calls* hit the API and authenticate. Precedence:

- **Auth**: `--api-key` > `B4M_API_KEY` env var > the CLI's stored login (`b4m login`).
- **Endpoint**: `B4M_API_URL` env var > `--api-url` > the CLI's configured backend.

Create a key in the app under **Settings > API Keys** with the scopes for the tools you plan to use (keys start `b4m_live_`). Prefer `B4M_API_KEY` over `--api-key`: a flag value is visible in process listings (`ps`), an env var is not.

### Transports

- **stdio (default)**: `b4m mcp serve`. For local clients like Claude Desktop that spawn the process and speak JSON-RPC over stdin/stdout.
- **streamable HTTP**: `b4m mcp serve --http --port 7000`. A stateless endpoint at `http://127.0.0.1:<port>/mcp` for clients that connect over HTTP.

HTTP mode binds **loopback only** (`127.0.0.1`) by design: it has no per-request auth of its own, so it must not be exposed on a routable interface. There is no flag to change the bind address. Only the `/mcp` path is served (any other path is a 404).

### Claude Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bike4mind": {
      "command": "b4m",
      "args": ["mcp", "serve"],
      "env": {
        "B4M_API_KEY": "b4m_live_xxx",
        "B4M_API_URL": "https://app.your-company.example.com"
      }
    }
  }
}
```

Restart Claude Desktop and the Bike4Mind tools appear in its tools menu.

## Headless / scripting mode

Run a single query non-interactively — useful in scripts and CI:

```bash
b4m -p "Summarize CHANGELOG.md" --output-format text
b4m -p "List the top 3 risks" --output-format json
b4m -p "…" --output-format stream-json    # NDJSON of thoughts/actions/observations
```

Add `--dangerously-skip-permissions` to auto-approve tool prompts in an unattended run (use with care). Headless mode honors the same environment selection as interactive mode.

## Troubleshooting

- **Prompted to pick a backend / banner says `Unconfigured`** — you're on a published fork build with no baked default. Choose one at the prompt, or point it directly: `b4m --api-url <url>` (or `--prod` on the upstream build). A source/linked checkout doesn't hit this — it defaults to the local dev server.
- **Can't reach a self-hosted stack** — confirm the app is up (`curl -s -o /dev/null -w '%{http_code}\n' localhost:3000` → `200`) and that you used the right host port. See [self-host troubleshooting](./SELF_HOST.md#troubleshooting).
- **No sign-in code (self-host)** — the code is emailed to Mailpit, not your inbox. Read it at `http://localhost:8025`.
- **Auth seems stuck after switching backends** — `--api-url` / `--reset-api` clear tokens for you; if needed, `/logout` then `/login`.
- **Empty model picker** — no provider key and no local model on that backend. For self-host, set a key in `.env.selfhost` or enable Ollama, then restart the stack.
- **Native-module errors on install** (`better-sqlite3`, `sharp`) — see [Build Requirements](./packages/cli/README.md#build-requirements).
- **Deeper diagnosis** — run `b4m --verbose` (or `b4m doctor`); every session also writes a debug log to `~/.bike4mind/debug/`.

---

Need help? Ask in [Discussions](https://github.com/bike4mind/bike4mind/discussions).
