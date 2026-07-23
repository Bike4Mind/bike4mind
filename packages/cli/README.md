# Bike4Mind CLI

Interactive command-line interface for Bike4Mind with ReAct agents.

## Features

- 🤖 ReAct agent with reasoning and tool use
- 💬 Interactive chat interface
- 💾 Session persistence
- 🛠️ B4M tools + MCP integration
- 🎨 Rich terminal UI with Ink
- 🖼️ Image paste and drag-and-drop support (iTerm2, Kitty)
- 🐛 Debug logging with `--verbose` flag
- 📄 Context file loading (CLAUDE.md, AGENTS.md, AI.md)
- 📁 File references with `@` autocomplete

## Installation

### From NPM (Recommended)

Install globally:

```bash
npm install -g @bike4mind/cli
```

Or run without installing:

```bash
npx @bike4mind/cli
```

### From Source (Development)

From the project root:

```bash
pnpm install
```

#### Build Requirements

The CLI uses native dependencies (`better-sqlite3` for image caching, `sharp` for image processing) that require compilation. These should build automatically during installation, but if you encounter errors:

**Prerequisites:**
- Python 3 (required by node-gyp)
- C++ compiler (Xcode Command Line Tools on macOS, build-essential on Linux, Visual Studio on Windows)

**Manual rebuild if needed:**
```bash
# If you see "Could not locate the bindings file" errors
pnpm rebuild better-sqlite3

# Or rebuild all native modules
pnpm rebuild
```

**Note:** The postinstall script will automatically rebuild `better-sqlite3` if the native bindings are missing, so manual intervention is rarely needed.

## Usage

### Start Interactive Session

```bash
b4m
```

The CLI will prompt you to authenticate with your Bike4Mind account on first run.

### CLI Flags

```bash
b4m [options] ["initial prompt"]
```

A bare positional argument seeds **and** submits the first turn while keeping the interactive UI open (e.g. `b4m "summarize the git log"`).

**Environment / API** (see [API Configuration](#api-configuration)):

| Flag | Effect |
| --- | --- |
| `--dev` | Point the CLI at the local dev server (`http://localhost:3001`) and remember it. Aliases: `--local`, single-dash forms. |
| `--prod` | Point the CLI at Bike4Mind production and remember it. Alias: `--production`. |
| `--api-url <url>` | Point the CLI at **any** instance — a self-hosted stack, an AWS deployment, `http://localhost:3000`, etc. Clears cached auth (bound to the old origin) and exits; run `b4m` again to sign in. |
| `--reset-api` | Reset the API URL to the built-in default and clear auth, then exit. |

**Session / behavior:**

| Flag | Effect |
| --- | --- |
| `--verbose`, `-v` | Show debug logs in the console (also always written to file — see [Debug Logs](#debug-logs)). |
| `--debug-stream` | Ultra-verbose: log every SSE event (stream-parser debugging). Implies `--verbose`. |
| `--no-project-config` | Skip loading project-specific config (`.bike4mind/`). |
| `--add-dir <dir>` | Grant file access to an additional directory. Repeatable. |
| `--ollama-host <url>` | Add a local Ollama endpoint's models to the picker (e.g. `http://localhost:11434`). |
| `--no-remote-skills` | Skip fetching remote B4M-web skills for this run (local files only). |

**Headless / non-interactive** (for scripts and CI):

| Flag | Effect |
| --- | --- |
| `-p`, `--prompt <query>` | Run a single query non-interactively and exit. |
| `--output-format <fmt>` | Output when using `-p`: `text` (default), `json`, or `stream-json` (NDJSON of thoughts/actions/observations). |
| `--dangerously-skip-permissions` | With `-p`, auto-allow all tool permission prompts. Use with caution in CI/CD. |

**Info:**

| Flag | Effect |
| --- | --- |
| `--help`, `-h` | Show help. |
| `--version`, `-V` | Show CLI version. |

> **Host / `claude`-drop-in flags** (`--mcp-config`, `--strict-mcp-config`, `--append-system-prompt`, `--allowedTools`, `--settings`, `--session-id`, `--resume`) are documented under [Running as a `claude` engine inside a host app](#running-as-a-claude-engine-inside-a-host-app).

**Examples:**
```bash
# Point at a self-hosted stack, then sign in
b4m --api-url http://localhost:3000
b4m

# One-shot headless query, JSON output
b4m -p "What is 2+2?" --output-format json

# Run with debug logs visible
b4m --verbose

# Seed and submit the first turn, stay interactive
b4m "review the recent changes"
```

### Subcommands

```bash
b4m mcp list                              # List configured MCP servers
b4m mcp add <name> -- <command...>        # Add an MCP server
b4m mcp remove <name>                     # Remove an MCP server
b4m mcp enable <name> | disable <name>    # Toggle a server on/off
b4m mcp serve [--http] [--port <n>]       # Expose Bike4Mind itself as an MCP server
b4m update                                # Check for and install CLI updates
b4m doctor                                # Diagnose the CLI installation (Node, registry, ripgrep, native modules)
```

### Switching environments (`--dev` / `--prod`)

Flip which backend the CLI talks to without editing config by hand:

```bash
b4m --dev    # local dev server (http://localhost:3001)
b4m --prod   # Bike4Mind production
b4m          # reuses whichever environment you last selected (sticky)
```

The choice is persisted to `~/.bike4mind/config.json`, so a bare `b4m` always
reopens the environment you last chose. Both single- and double-dash forms work
(`-dev`/`--dev`, `-prod`/`--prod`); `--local` is an alias for `--dev`.

Auth tokens are cached **per environment**, so switching back and forth does not
force a re-login — each environment remembers its own session. The first time you
visit a new environment you'll be prompted to `/login`. The active environment is
shown in the startup banner (`🌍 API Environment: …`).

> For a one-off custom/self-hosted URL, use the in-session `/set-api <url>` command
> (see [API Configuration](#api-configuration) below).

## Commands

While in interactive mode. This mirrors the registry in `src/config/commands.ts` — run `/help` in a session for the live list (which also includes any custom and project commands).

**Authentication:**
- `/login` - Authenticate with your B4M account
- `/logout` - Clear authentication and sign out
- `/whoami` - Show current authenticated user

**Session management:**
- `/save <name>` - Save current session
- `/resume` (alias `/sessions`) - List and resume saved sessions
- `/clear` (alias `/new`) - Start a new session
- `/compact [instructions]` - Compact the conversation into a new session
- `/context` - Show context-window usage
- `/usage` - Show credit usage and balance

**API configuration:**
- `/set-api <url>` - Connect to a self-hosted / custom Bike4Mind instance
- `/reset-api` - Reset to the Bike4Mind main service
- `/api-info` - Show current API configuration

**Files & checkpoints:**
- `/add-dir <path>` / `/remove-dir <path>` / `/dirs` - Manage accessible directories
- `/undo` - Undo the last file change
- `/checkpoints` - List file restore points
- `/restore <number>` - Restore files to a checkpoint
- `/diff [number]` - Diff current state against a checkpoint
- `/rewind` - Rewind the conversation to a previous point

**Tool permissions:**
- `/trust <tool-name>` / `/untrust <tool-name>` / `/trusted` - Manage auto-approved tools

**Sandbox** (OS-level isolation for `bash`):
- `/sandbox` - Show sandbox status and configuration
- `/sandbox:enable` / `/sandbox:disable` - Toggle the sandbox
- `/sandbox:mode <auto-allow|permissions>` - Set enforcement mode
- `/sandbox:trust-domain <domain> [...]` / `/sandbox:domains` - Manage the network allowlist
- `/sandbox:violations [count]` / `/sandbox:violations:clear` - Inspect / clear violations

**MCP & agents:**
- `/mcp` (alias `/mcp:list`) - Show MCP server status and connected tools
- `/agents` (alias `/agents:list`) - List available agents
- `/agents:new <name>` / `/agents:reload` - Create / reload agent definitions

**Custom commands:**
- `/commands` - List all custom commands
- `/commands:new <name>` / `/commands:reload` - Create / reload custom commands

**Durable workflow** (cross-session continuity):
- `/workflow [decisions|blockers|handoff|review-gates]` - Workflow overview or a section
- `/decisions` / `/blockers` / `/review-gates` - Shortcuts for the sections above
- `/handoff [generate|--local]` - Show or generate a session handoff (`--local` = LLM-free snapshot)

**General:**
- `/help` - Show help
- `/config` - Open the interactive configuration editor
- `/project-config` - Show merged project configuration
- `/terminal-setup` - Configure Shift+Enter for multi-line input
- `/exit` (alias `/quit`) - Exit the CLI

## Configuration

Configuration is stored in `~/.bike4mind/config.json`

### Authentication

The CLI uses OAuth to authenticate with your Bike4Mind account. On first run, you'll be prompted to log in through the device authorization flow:

1. Run `b4m` or use the `/login` command
2. Visit the verification URL shown in the terminal
3. Enter the user code to authorize the CLI
4. The CLI will automatically receive access tokens

Authentication tokens are securely stored in your config file with restricted permissions (0600).

### API Configuration

By default, the published CLI connects to the main Bike4Mind service at `https://app.bike4mind.com`.
The default is baked in at build time from the hosted build environment — there is **no brand
fallback in source** (open-core, #9306/#9392), so a fresh clone ships empty. A fork publishes its
own CLI by setting `B4M_DEFAULT_API_URL` when building — see `tsdown.config.ts`.

Because that default is injected only at build time, the endpoint is resolved like this:

1. A **custom URL** you set (`--api-url` / `--dev` / `--prod` / `/set-api`) always wins.
2. Otherwise, the **build-time default** baked into a published binary.
3. Otherwise, when running **from source** (a `pnpm link --global` checkout, `pnpm dev` — no
   `dist/` built), the CLI defaults to the local dev server `http://localhost:3001`. Use
   `--prod` / `--api-url` to point it elsewhere.
4. Otherwise (a published, unbranded fork with no baked default), the first `b4m` **prompts you
   to choose a backend**.

**Quick switch between local dev and production:** use the `b4m --dev` / `b4m --prod`
launch flags (see [Switching environments](#switching-environments---dev----prod)).
They persist your choice and cache auth per-environment. The `/set-api`, `/reset-api`,
and `/api-info` commands below operate on the same setting from inside a session.

**For self-hosted / custom instances:**

The CLI can point at **any** Bike4Mind deployment — a self-hosted Docker stack, an AWS deployment, or `http://localhost:3000` — because auth (the OAuth device flow) and the chat API ship in the open core and are served by that instance directly.

From the launch line (clears auth, then exit — run `b4m` again to sign in):

```bash
b4m --api-url http://localhost:3000              # local self-host Docker stack
b4m --api-url https://app.your-instance.example.com
b4m --reset-api                                  # back to the built-in default
```

Or from inside a session:

```bash
/set-api https://app.your-instance.example.com
/reset-api    # return to the default service
/api-info     # show the current API configuration
```

Auth tokens are cached **per environment**, so switching between hosted and self-host does not force a re-login. For an end-to-end walkthrough (hosted **and** self-host, sign-in, credits, troubleshooting), see the top-level [**BIKE4MIND_CLI.md**](../../BIKE4MIND_CLI.md).

### Tool API Keys

Some built-in tools require API keys to function. Add them to `~/.bike4mind/config.json`:

```json
{
  "toolApiKeys": {
    "openweather": "your-openweather-key",
    "serper": "your-serper-key"
  }
}
```

Or use environment variables (config takes precedence):

```bash
export OPENWEATHER_API_KEY="your-key-here"
export SERPER_API_KEY="your-key-here"
```

**Available Tools:**
- ✅ `dice_roll` - No API key needed
- ✅ `math_evaluate` - No API key needed
- ✅ `current_datetime` - No API key needed
- ✅ `prompt_enhancement` - No API key needed
- ✅ `bash_execute` - No API key needed
- ✅ `recent_changes` - No API key needed (git-based file search by modification time)
- 🔑 `weather_info` - Requires `toolApiKeys.openweather`
- 🔑 `web_search` - Requires `toolApiKeys.serper`
- 🔑 `deep_research` - Requires `toolApiKeys.serper`

**Get API Keys:**
- OpenWeather API: https://openweathermap.org/api
- Serper API: https://serper.dev/

### Optional: MCP Servers

MCP (Model Context Protocol) servers provide additional tools and capabilities. Configure them in `~/.bike4mind/config.json`:

#### Internal MCP Servers (Node.js)

For MCP servers bundled with the monorepo, you can omit `command` and `args` - the CLI will automatically discover them:

```json
{
  "mcpServers": [
    {
      "name": "github",
      "env": {
        "GITHUB_ACCESS_TOKEN": "ghp_..."
      },
      "enabled": true
    }
  ]
}
```

#### External MCP Servers (Docker)

You can run MCP servers in Docker containers for isolation and portability:

```json
{
  "mcpServers": [
    {
      "name": "github",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      },
      "enabled": true
    }
  ]
}
```

**Docker Configuration Notes:**
- The `-i` flag is required for stdin communication with the MCP server
- Use `-e VAR_NAME` (without value) to pass environment variables from the host
- The `--rm` flag ensures containers are cleaned up after use
- Requires Docker to be installed and running

#### External MCP Servers (npx/Custom Commands)

You can also run any MCP server via npx or custom executables:

```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
      "env": {},
      "enabled": true
    }
  ]
}
```

**Available Built-in MCP Servers:**
- 🔧 **GitHub** - Repository management, issues, PRs (requires `GITHUB_ACCESS_TOKEN`)
- 🔧 **LinkedIn** - Post management, analytics (requires `LINKEDIN_ACCESS_TOKEN`, `COMPANY_NAME`)
- 🔧 **Atlassian** - Jira/Confluence integration (requires `ATLASSIAN_ACCESS_TOKEN`, `ATLASSIAN_CLOUD_ID`, `ATLASSIAN_SITE_URL`)

**Note:** Internal MCP servers must be built and available in the `b4m-core/packages/mcp/dist/src/` directory. The CLI will automatically find them if you're running from the monorepo. For Docker-based servers, ensure Docker is installed and the image is accessible.

#### Serve Bike4Mind itself as an MCP server (`b4m mcp serve`)

The reverse of adding a server: `b4m mcp serve` exposes your Bike4Mind backend to any MCP client (Claude Desktop, editors, other agents). It advertises seven tools (`list_notebooks`, `get_notebook`, `create_notebook`, `send_message`, `search_knowledge_base`, `list_files`, `get_file`) plus four resource templates (`b4m://notebook/{id}`, `b4m://file/{id}`, `b4m://project/{id}`, `b4m://artifact/{id}`), each listable and readable as JSON.

```bash
b4m mcp serve                        # stdio (default) - for local clients that spawn the process
b4m mcp serve --http --port 7000     # stateless streamable HTTP at http://127.0.0.1:7000/mcp
```

Auth precedence is `--api-key` > `B4M_API_KEY` > the stored login; the endpoint is `B4M_API_URL` > `--api-url` > the configured backend. Tool *listing* needs no credentials; tool *calls* authenticate. Prefer `B4M_API_KEY` over `--api-key` (a flag value shows up in process listings). HTTP mode binds loopback only (`127.0.0.1`, `/mcp` path) and has no per-request auth, so do not expose it off-host. The advertised scopes are the recommended key configuration, not per-route hard gates. See [Serve Bike4Mind as an MCP server](../../BIKE4MIND_CLI.md#serve-bike4mind-as-an-mcp-server-b4m-mcp-serve) for the Claude Desktop config and details.

## Plugins

The CLI can load external feature modules at runtime. A plugin is an npm package that adds tools, a system-prompt section, slash commands, and (optionally) WebSocket handlers to the interactive session, without any change to the CLI itself.

```bash
b4m plugin add @someone/b4m-plugin-foo     # install from npm
b4m plugin add github:user/b4m-plugin-foo  # install from GitHub
b4m plugin add file:/path/to/local/plugin  # install a local directory (development/QA)
b4m plugin list                            # show installed plugins and their state
b4m plugin remove foo                      # uninstall and disable
```

Plugins install to `~/.bike4mind/plugins/` and are gated by a `features` toggle in your config: `add` enables it for you, and every installed plugin also shows up automatically in the `/config` editor. A newly installed plugin loads the next time you start `b4m`; toggling an already-installed plugin in `/config` hot-reloads it in place.

### Writing a plugin

A plugin declares itself with a `b4m-plugin` field in its `package.json`:

```json
{
  "name": "@someone/b4m-plugin-foo",
  "type": "module",
  "b4m-plugin": { "entry": "./dist/index.js", "configKey": "foo" }
}
```

`entry` (required) is the module the CLI imports, resolved inside the package. `configKey` (optional, defaults to the package name) is the `features` key that gates the plugin.

The entry default-exports a factory. It receives a context (currently `{ logger }`, with `debug/info/warn/error` methods that write to the CLI debug log) and returns the module object:

```js
export default ctx => ({
  name: 'foo',                       // unique module name
  description: 'What this plugin does',
  getTools: () => [
    {
      toolFn: async args => 'result',   // invoked when the agent calls the tool
      toolSchema: {
        name: 'foo_tool',
        description: 'What the tool does',
        parameters: { type: 'object', properties: {} },  // JSON Schema
      },
    },
  ],
  getSystemPromptSection: () => 'Extra system-prompt text (or an empty string)',
  getCommands: () => [{ name: 'foo', description: '...', execute: args => {} }],  // optional
  registerWsHandlers: wsManager => {},  // optional
  dispose: () => {},                    // optional, runs on exit/disable
});
```

Tool objects are written out structurally as shown - plugin packages cannot import `@bike4mind/*` packages at runtime (those are bundled into the CLI binary and are not on npm in a compatible form). See `test/fixtures/b4m-plugin-example/` in this package for a complete working plugin.

### Limitations and trust

- **Plugins run in-process with your privileges.** Installing one runs its npm install scripts, and enabling it executes its code inside the CLI, same as configuring an MCP server command. Only install plugins you trust.
- **Interactive mode only.** Headless (`b4m -p`) and ACP sessions do not load feature modules or plugins today.
- **Downgrade caveat:** CLI versions without plugin support strip plugin keys from the config `features` map on their next save; re-enable after upgrading again.
- A plugin that fails to load (bad manifest, import error, malformed tools) is skipped with a warning at startup - it never blocks the CLI. `b4m plugin list` shows the reason.

## Git-Aware Code Search

The CLI includes a `recent_changes` tool that uses git history to find recently modified files. This significantly speeds up debugging by narrowing the search space to recently changed code.

### Use Cases

- **Recent bug debugging:** "I just broke something, can you help fix it?"
- **Understanding feature development:** "What did we change for the new dashboard?"
- **Finding active development areas:** "What are we actively working on?"
- **Code review prep:** "What changed since last release?"

### Parameters

- `since` - Time range to search (default: "7 days ago")
  - Examples: "2 hours ago", "3 days ago", "2025-01-01"
- `path` - Filter to specific directory (default: entire repo)
  - Examples: "src/components", "apps/client", "**/*.test.ts"
- `limit` - Maximum files to return (default: 50)
- `include_stats` - Show lines added/removed (default: false)

### How It Works

The tool uses `git log` to track file modifications and returns:
- Files sorted by activity (most commits first)
- Commit messages for context
- Optional statistics showing lines changed
- Filtered results based on time and path

**Performance benefit:** Instead of searching 50+ files (5-10 minutes), find the 3 relevant files in ~30 seconds.

## Context Files

The CLI supports loading project-specific instructions from context files, similar to CLAUDE.md in Claude Code. These files provide persistent instructions that are automatically included in the agent's system prompt.

### Supported Files

**Project-level** (in your project directory, checked in priority order):
1. `CLAUDE.local.md` - Personal/gitignored instructions (highest priority)
2. `CLAUDE.md` - Project instructions
3. `AGENTS.md` - Cross-tool standard
4. `AI.local.md` - Personal/gitignored instructions
5. `AI.md` - Project instructions
6. `INSTRUCTIONS.md` - Project instructions (lowest priority)

**Global** (in `~/.bike4mind/`):
1. `AI.local.md` - Personal global instructions
2. `AI.md` - Global instructions

### How It Works

- The CLI loads the **first matching file** from each layer (global and project)
- Project files take precedence over global files
- `.local.md` variants are intended to be gitignored for personal preferences
- Files must be under 100KB
- Symlinks are rejected for security

### Example

Create a `CLAUDE.md` in your project:

```markdown
# Project Instructions

- Always use TypeScript strict mode
- Prefer functional components with hooks
- Run tests before committing
```

On startup, you'll see:
```
📄 Project context: CLAUDE.md
```

The agent will follow these instructions for all interactions in that project.

## Session Storage

Sessions are saved to `~/.bike4mind/sessions/`

Each session includes:
- Full conversation history
- Token usage tracking
- Agent reasoning steps
- Metadata

## Debug Logs

Debug logs are automatically written to `~/.bike4mind/debug/[session-id].txt` for every session, regardless of the `--verbose` flag.

**What's logged:**
- Session configuration (API endpoint, environment, model)
- HTTP requests and responses (with size and preview)
- SSE streaming events from LLM
- Tool execution details with parameters
- Error details including CloudFront/WAF errors
- Authentication flow events

**Accessing logs:**
```bash
# List all debug logs
ls -lh ~/.bike4mind/debug/

# View latest session log
cat ~/.bike4mind/debug/[session-id].txt

# View logs in real-time (during session)
tail -f ~/.bike4mind/debug/[session-id].txt
```

**Log retention:**
- Debug logs older than 30 days are automatically cleaned up on CLI startup
- Each log file is named by session ID for easy correlation

**Verbose mode:**
- Without `--verbose`: Debug logs only written to file (clean console output)
- With `--verbose`: Debug logs shown in console AND written to file

## Development

This section covers the contributor workflow for hacking on the CLI from a checkout of the monorepo. For end-user installation see [Installation](#installation) above.

### Prerequisites

- **Node.js 24+** and **pnpm 10+** — the repo's `engines` field requires these versions. If you use [corepack](https://nodejs.org/api/corepack.html) (bundled with Node), run `corepack enable` from the repo root and it will activate the exact pnpm version pinned in the root `package.json`.
- Native-module build tools (Python 3 + a C++ compiler) for `better-sqlite3` and `sharp` — see [Build Requirements](#build-requirements) above.

### How the bin resolves source vs. built code

`packages/cli/bin/bike4mind-cli.mjs` auto-detects which mode to run in:

- If `packages/cli/dist/index.mjs` exists → runs the bundled production build
- Otherwise → falls back to `tsx` and imports `src/index.tsx` directly

This means **you do not need to rebuild the CLI itself between source edits** — `tsx` reads `src/` live on every invocation. The rebuild burden is only on the workspace packages that the CLI imports (see below).

### Quick start

From the repo root:

```bash
# 1. Install all workspace dependencies
pnpm install

# 2. Build the @bike4mind/* core packages so the CLI can import their dist/ outputs
pnpm turbo:core:build

# 3. Ensure pnpm has a global bin directory (once per machine). Without this,
#    `pnpm link --global` fails with ERR_PNPM_NO_GLOBAL_BIN_DIR. `pnpm setup`
#    appends PNPM_HOME to your shell profile — open a new shell afterward.
pnpm setup

# 4. Make the `b4m` and `bike4mind` commands point at this checkout
cd packages/cli
pnpm link --global

# 5. Verify
which b4m
b4m --version
```

After step 4, running `b4m` anywhere on your system executes this working tree. Re-run `pnpm link --global` if you move or rename the repo.

> **Which backend does a linked checkout talk to?** A source/linked run has no build-time
> default baked in, so `b4m` defaults to the local dev server (`http://localhost:3001`) — start
> your local stack, or point it elsewhere with `b4m --prod` / `b4m --api-url <url>`. See
> [API Configuration](#api-configuration) for the full resolution order.

### Editing CLI source (`packages/cli/src/`)

Just run `b4m`. The bin's `tsx` fallback picks up your edits on the next invocation — no build step needed.

If you want to test the bundled production path (the same code an end user would run after `npm install -g @bike4mind/cli`):

```bash
pnpm --filter @bike4mind/cli build
b4m   # now uses dist/index.mjs
```

To drop back into source mode, delete `dist/`:

```bash
rm -rf packages/cli/dist
```

### Editing workspace dependencies (`b4m-core/*`)

The CLI imports `@bike4mind/agents`, `@bike4mind/services`, `@bike4mind/utils`, `@bike4mind/mcp`, and `@bike4mind/common` via pnpm symlinks that resolve to each package's `dist/` (per its `exports` field). Source edits in those packages require a rebuild before `b4m` will see them.

Rebuild only the package you touched:

```bash
pnpm --filter @bike4mind/agents build
```

Or rebuild the whole core graph (cached, near-instant if only one package changed):

```bash
pnpm turbo:core:build
```

The next `b4m` invocation picks up the change. The CLI itself does not need to be rebuilt.

### Watch mode (optional)

Each core package exposes `"dev": "tsdown --watch"`. In a separate terminal:

```bash
pnpm --filter @bike4mind/agents dev
```

`dist/` rebuilds on save, so the next `b4m` invocation sees changes without a manual `build`.

Caveats:
- This does **not** hot-reload an already-running interactive `b4m` session — you still exit and re-run.
- Running multiple watchers in parallel (one per package you're touching) hasn't been load-tested in this repo. If watch seems to miss changes or feels unreliable, fall back to manual `pnpm --filter <pkg> build`.

### Verification commands

```bash
# Inside packages/cli
pnpm typecheck
pnpm test
pnpm test:watch

# From repo root (cached, recommended)
pnpm turbo:typecheck
pnpm turbo:test

# Run with debug logs
b4m --verbose
```

### Common pitfalls

- **Don't `pnpm --filter @bike4mind/cli build` after every CLI source edit.** It's wasted work — the `tsx` fallback already runs your source live.
- **Don't use `npm link`.** This repo is pnpm-only; mixing tools breaks symlink resolution.
- **A stale `packages/cli/dist/` will mask your source changes.** If `b4m` is showing old behavior, check whether `dist/index.mjs` exists — the bin will prefer it over `src/`. Delete `dist/` to drop back to source mode.
- **First-run native module errors** (`better-sqlite3`, `sharp`): see [Build Requirements](#build-requirements) above. The postinstall hook handles most cases automatically.

## Architecture

```
packages/cli/
├── src/
│   ├── components/       # Ink React components
│   │   ├── App.tsx
│   │   ├── StatusBar.tsx
│   │   ├── MessageList.tsx
│   │   ├── InputPrompt.tsx
│   │   └── ThoughtStream.tsx
│   ├── storage/          # Local persistence
│   │   ├── SessionStore.ts
│   │   └── ConfigStore.ts
│   └── index.tsx         # Main entry point
└── bin/
    └── bike4mind-cli.mjs  # Executable (source/dist auto-detect + flag parsing)
```

## Dependencies

- `@bike4mind/agents` - ReAct agent implementation
- `@bike4mind/services` - B4M tools
- `@bike4mind/mcp` - MCP integration
- `@bike4mind/utils` - LLM backends
- `ink` - React for CLIs
- `yargs` - CLI argument parsing
- `lowdb` - Local storage

## Development Status

Current implementation includes:

✅ Basic CLI structure
✅ ReAct agent integration
✅ Session persistence
✅ Configuration management
✅ Interactive UI with Ink
✅ B4M tools integration
✅ MCP tools support
✅ Debug logging with --verbose flag
✅ Context file loading (CLAUDE.md, AGENTS.md, AI.md)

Coming soon:

⏳ Advanced UI features (streaming visualization, syntax highlighting)
⏳ Export functionality (sessions to markdown/JSON)
⏳ Session search and management
⏳ Tool execution monitoring

## Running as a `claude` engine inside a host app

The CLI can be driven by a host app (e.g. a kanban-style agent pipeline) as a
drop-in replacement for `claude` — running a pipeline **stage** or a **board AI /
YAML** pane with full parity (board tools over HTTP MCP, the 3-layer brief
injected, the spec auto-fired on turn 1, and the live-card `processing` /
`action_required` / `ready` signal).

A host that only launches an engine whose executable basename is exactly `claude`
can be pointed at a **symlink** named `claude`:

```bash
# Create a claude-named symlink to the CLI entry point somewhere on disk:
ln -s "$(pwd)/packages/cli/bin/bike4mind-cli.mjs" /usr/local/bin/claude-b4m/claude

# In the host, set the engine's `terminal_command` to that symlink path:
#   /usr/local/bin/claude-b4m/claude
```

Use a **direct symlink** whose basename is `claude` — not a `package.json` bin
alias (it would shadow the real `claude`) and not a wrapper shell script (argv
gets mangled). No other setup is required; the CLI replicates claude's launch-flag
and lifecycle-hook contract.

### Supported claude-compatible flags

These are parsed in `bin/bike4mind-cli.mjs` into `B4M_*` env vars consumed by the
runtime. Unknown flags are tolerated (never hard-error) and the interactive TUI is
preserved (a positional prompt seeds **and** submits turn 1 without switching to
headless `-p`):

| Flag | Effect |
| --- | --- |
| `--mcp-config <file>` | Inject MCP servers from a claude-shape JSON (`{ "mcpServers": {...} }`). Supports HTTP transport (`type: "http"`, `url`, `headers`) with per-launch Bearer auth. |
| `--strict-mcp-config` | Use ONLY `--mcp-config` servers; ignore file-config and `.mcp.json` (board YAML pane). |
| `--append-system-prompt <text>` | Append text verbatim to the end of the system prompt (the 3-layer brief). |
| `--allowedTools <patterns>` | Auto-approve matching tools without a permission prompt (glob `mcp__manifold__*` or a space-separated explicit list). |
| `--settings <json>` | Inline JSON; the `hooks` subset drives lifecycle hooks (see below). Malformed JSON is ignored, never fatal. |
| `--session-id <uuid>` / `--resume <uuid>` | Pin / resume a session (board pane). `/clear` and `/compact` keep the pinned uuid; a bad `--resume` prints `No conversation found with session ID <uuid>` and exits non-zero so the host can self-heal the pane. |
| `<positional prompt>` | Seeds and auto-fires turn 1 while staying interactive. |

### Lifecycle hooks (`--settings.hooks`)

Mirrors claude's hook contract for the host's `action_required` signal: a
`Notification`/`permission_prompt` command writes a sentinel file while an
interactive permission prompt blocks; `PostToolUse` / `Stop` / `UserPromptSubmit`
commands remove it. Each hook command runs via a real shell with its stdin piped
then closed (EOF), so a blocking `cat > <file>` hook returns immediately.

## License

Private - Bike4Mind
