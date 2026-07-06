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
2. Otherwise, a **build-time default** baked into the published binary. The upstream `@bike4mind/cli` bakes the hosted service; an [open-core fork](./CONTRIBUTING.md#the-openclosed-boundary) that publishes its own CLI without setting `B4M_DEFAULT_API_URL` ships **empty** — a bare `b4m` then reads as `Unconfigured`, and you **must** point it somewhere with `--api-url` before signing in.

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
- **Streaming.** The self-host stack does not yet include the realtime websocket gateway; see the [self-host gaps](./SELF_HOST.md#what-you-get-and-dont).

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

## Headless / scripting mode

Run a single query non-interactively — useful in scripts and CI:

```bash
b4m -p "Summarize CHANGELOG.md" --output-format text
b4m -p "List the top 3 risks" --output-format json
b4m -p "…" --output-format stream-json    # NDJSON of thoughts/actions/observations
```

Add `--dangerously-skip-permissions` to auto-approve tool prompts in an unattended run (use with care). Headless mode honors the same environment selection as interactive mode.

## Troubleshooting

- **Banner says `Unconfigured`** — you're on a fork build with no baked default. Point it somewhere: `b4m --api-url <url>` (or `--prod` on the upstream build).
- **Can't reach a self-hosted stack** — confirm the app is up (`curl -s -o /dev/null -w '%{http_code}\n' localhost:3000` → `200`) and that you used the right host port. See [self-host troubleshooting](./SELF_HOST.md#troubleshooting).
- **No sign-in code (self-host)** — the code is emailed to Mailpit, not your inbox. Read it at `http://localhost:8025`.
- **Auth seems stuck after switching backends** — `--api-url` / `--reset-api` clear tokens for you; if needed, `/logout` then `/login`.
- **Empty model picker** — no provider key and no local model on that backend. For self-host, set a key in `.env.selfhost` or enable Ollama, then restart the stack.
- **Native-module errors on install** (`better-sqlite3`, `sharp`) — see [Build Requirements](./packages/cli/README.md#build-requirements).
- **Deeper diagnosis** — run `b4m --verbose` (or `b4m doctor`); every session also writes a debug log to `~/.bike4mind/debug/`.

---

Need help? Ask in [Discussions](https://github.com/bike4mind/bike4mind/discussions).
