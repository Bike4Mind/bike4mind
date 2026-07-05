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
b4m [options]
```

**Available flags:**
- `--dev` - Point the CLI at the local dev server (`http://localhost:3001`) and remember it
- `--prod` - Point the CLI at Bike4Mind production and remember it
- `--verbose`, `-v` - Show debug logs in console (useful for troubleshooting)
- `--help`, `-h` - Show help information
- `--version`, `-V` - Show CLI version

**Examples:**
```bash
# Run with debug logs visible
b4m --verbose

# Check version
b4m --version

# Show help
b4m --help
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

While in interactive mode:

**Authentication:**
- `/login` - Authenticate with your B4M account
- `/logout` - Clear authentication and sign out
- `/whoami` - Show current authenticated user

**Session Management:**
- `/save <name>` - Save current session
- `/resume` - List and resume saved sessions

**API Configuration:**
- `/set-api <url>` - Connect to self-hosted Bike4Mind instance
- `/reset-api` - Reset to Bike4Mind main service
- `/api-info` - Show current API configuration

**Tool Permissions:**
- `/trust <tool-name>` - Trust a tool (won't ask permission again)
- `/untrust <tool-name>` - Remove tool from trusted list
- `/trusted` - List all trusted tools

**General:**
- `/help` - Show help
- `/exit` - Exit CLI
- `/config` - Show configuration

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

**Quick switch between local dev and production:** use the `b4m --dev` / `b4m --prod`
launch flags (see [Switching environments](#switching-environments---dev----prod)).
They persist your choice and cache auth per-environment. The `/set-api`, `/reset-api`,
and `/api-info` commands below operate on the same setting from inside a session.

**For Self-Hosted Instances:**

If your organization runs a self-hosted Bike4Mind instance, connect to it using:

```bash
/set-api https://app.your-instance.example.com
```

To return to the main Bike4Mind service:

```bash
/reset-api
```

Check your current API configuration:

```bash
/api-info
```

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
    └── bike4mind-cli.js  # Executable
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
