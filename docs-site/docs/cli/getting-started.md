---
title: Getting Started with B4M CLI
description: Quick start guide to install and use the B4M CLI
sidebar_position: 2
---

# Getting Started with B4M CLI

Get up and running with B4M CLI in under 2 minutes.

## Installation

Install B4M CLI globally to use the `b4m` command anywhere:

```bash
npm install -g @bike4mind/cli
```

**Verify installation:**
```bash
b4m --version
```

## System Requirements

- **Node.js**: Version 24 or higher ([Download](https://nodejs.org/))
- **Terminal**: Any modern terminal (iTerm2, Windows Terminal, GNOME Terminal, etc.)
- **Colors**: 256-color support recommended for best experience
- **Internet**: Required for cloud features and authentication

**Check your Node.js version:**
```bash
node --version
# Should show v24.0.0 or higher
```

## First Run

### 1. Start the CLI

```bash
b4m
```

On first run, you'll see the welcome screen:

```
██████╗ ██╗  ██╗███╗   ███╗
██╔══██╗██║  ██║████╗ ████║
██████╔╝███████║██╔████╔██║
██╔══██╗╚════██║██║╚██╔╝██║
██████╔╝     ██║██║ ╚═╝ ██║
╚═════╝      ╚═╝╚═╝     ╚═╝

  v0.2.10 - AI-Powered CLI
  /help for more information

📝 Loaded 1 custom command

⚠️  Not authenticated.
💡 Run /login to authenticate with your B4M account.
📖 You can still browse help and documentation without authentication.

ℹ️  AI features disabled. Available commands: /login, /help, /config

> Type your message, /help for commands, @file to reference, or ! for bash
```

**Note:** The CLI doesn't automatically prompt for authentication. You need to manually run `/login`.

### 2. Authenticate

To use AI features, authenticate with your Bike4Mind account:

```bash
> /login
```

The CLI will display the device authorization screen and **automatically open your browser**:

```
╭────────────────────────────────────────────────────────╮
│                                                        │
│ 🔐 Device Authorization                                │
│                                                        │
│ Opening browser automatically...                       │
│ If it doesn't open, please visit:                     │
│                                                        │
│   https://app.bike4mind.com/activate                  │
│                                                        │
│ And enter this code when prompted:                    │
│                                                        │
│   L2JQ-CRZ9                                           │
│                                                        │
│                                                        │
│ ⠏ Waiting for user authorization...                   │
│                                                        │
│ Expires in 10 minutes                                 │
│                                                        │
╰────────────────────────────────────────────────────────╯
```

**What happens:**
1. **Browser opens automatically** with the activation URL
2. **Code is prepopulated** in the browser (you don't need to type it)
3. **Verify the code** matches what's shown in the CLI
4. **Click "Approve"** to authorize the CLI
5. The CLI automatically detects the authorization and continues

**Success:**
```
✓ Authentication successful!
Logged in as: john@example.com
```

**If browser doesn't open:**
- Manually visit the URL shown in the terminal
- The code is already prepopulated, just verify and approve

### 3. Start Chatting

Once authenticated, you're ready to use all AI features!

```bash
> Hello! What can you help me with?

I can help you with many tasks like:
- Answering questions and providing information
- Running shell commands
- Searching the web
- Getting weather information
- Performing calculations
- And much more!

What would you like to do today?
```

## Your First Tasks

### Ask a Question

```bash
> What's the capital of France?

The capital of France is Paris. It's the largest city in France and has been
the country's capital since the 12th century.
```

### Run a Shell Command

```bash
> List all JavaScript files in the current directory

Let me run that command for you.
[tool: bash_execute]

Found 24 JavaScript files:
- src/index.js
- src/app.js
- src/utils.js
...
```

### Get Weather Information

```bash
> What's the weather in New York?

[tool: weather_info]

Current weather in New York:
- Temperature: 72°F (22°C)
- Conditions: Partly cloudy
- Humidity: 65%
- Wind: 8 mph NW
```

### Search the Web

```bash
> Search for recent TypeScript features

[tool: web_search]

Here are the latest TypeScript features:

1. **TypeScript 5.5 (Released 2024)**
   - Inferred type predicates
   - Control flow narrowing improvements
   ...
```

## Essential Commands

While chatting, you can use special commands that start with `/`:

### Authentication Commands

```bash
/whoami          # Show current user
/logout          # Sign out and clear tokens
/login           # Re-authenticate
```

### Session Management

```bash
/sessions        # List all saved sessions
/save my-work    # Save current conversation
```

### Configuration

```bash
/config          # Show current configuration
/api-info        # Show API endpoint info
/set-api <url>   # Connect to self-hosted instance
/reset-api       # Reset to default endpoint
```

### Tool Permissions

```bash
/trusted         # List trusted tools
/trust bash      # Trust the bash_execute tool
/untrust bash    # Require permission for bash_execute
```

### Help & Exit

```bash
/help            # Show help
/exit            # Quit (or press Ctrl+C)
```

**See all commands:** [Commands Reference →](/cli/commands)

## CLI Flags

### Show Debug Logs

Run with `--verbose` or `-v` to see detailed debug information:

```bash
b4m --verbose
```

This shows:
- HTTP requests and responses
- Tool execution details
- SSE streaming events
- Error diagnostics

**Note:** Debug logs are always saved to `~/.bike4mind/debug/[session-id].txt`, regardless of the verbose flag.

### Check Version

```bash
b4m --version
# or
b4m -V
```

### Show Help

```bash
b4m --help
# or
b4m -h
```

## Project Context Files

B4M CLI automatically loads project-specific instructions from context files in your current directory.

### Supported Files (Priority Order)

1. `CLAUDE.local.md` - Personal instructions (gitignored)
2. `CLAUDE.md` - Project instructions (checked in)
3. `AGENTS.md` - Cross-tool standard
4. `AI.local.md` - Personal instructions
5. `AI.md` - Project instructions
6. `INSTRUCTIONS.md` - Project instructions

**Example: Create a `CLAUDE.md`**

```bash
cat > CLAUDE.md << 'EOF'
# Project Instructions

- Always use TypeScript strict mode
- Run tests before committing
- Follow the existing code style
- Update documentation with code changes
EOF
```

**On startup, you'll see:**

```bash
📄 Project context: CLAUDE.md
```

The agent will follow these instructions for all interactions in that project.

**Learn more:** [Configuration → Context Files](/cli/configuration#context-files)

## File Locations

B4M CLI stores data in `~/.bike4mind/`:

```
~/.bike4mind/
├── config.json           # User configuration & tokens
├── sessions/             # Saved conversations
│   ├── session-1.json
│   └── session-2.json
└── debug/                # Debug logs (auto-cleanup after 30 days)
    ├── abc123.txt
    └── def456.txt
```

**Permissions:**
- `config.json`: 0600 (readable/writable by you only)
- Other files: 0644 (readable by all, writable by you)

## Next Steps

Now that you're set up, explore what B4M CLI can do:

<div class="button-group">

[Commands Reference →](/cli/commands)
*Learn all available commands*

[Configuration →](/cli/configuration)
*Customize your setup*

[Features Guide →](/cli/features)
*Deep dive into capabilities*

[Examples →](/cli/examples)
*Real-world use cases*

</div>

## Quick Tips

### Keyboard Shortcuts

- `Ctrl+C` - Cancel current operation or exit CLI
- `↑` / `↓` - Navigate command history (in future versions)
- `Tab` - Autocomplete (in future versions)

### Tool Permissions

First time a tool runs, you'll be asked:

```bash
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ ⚠️ Permission Required                      ┃
┃                                            ┃
┃ Tool: bash_execute                         ┃
┃                                            ┃
┃ Arguments:                                 ┃
┃   { "command": "ls -la" }                  ┃
┃                                            ┃
┃ ❯ ✓ Allow once                             ┃
┃   ✓ Always allow (trust this tool)         ┃
┃   ✗ Deny                                   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

**Options:**
- **Allow once** - Permit this execution only
- **Always allow** - Trust this tool (won't ask again)
- **Deny** - Block this execution

### Saving Sessions

Always save important conversations:

```bash
/save my-project-work
```

Sessions are saved to `~/.bike4mind/sessions/` and can be resumed later.

### Debug Issues

If something isn't working:

1. **Check logs:**
   ```bash
   ls ~/.bike4mind/debug/
   tail -f ~/.bike4mind/debug/[latest-file].txt
   ```

2. **Run with verbose:**
   ```bash
   b4m --verbose
   ```

3. **Check authentication:**
   ```bash
   b4m
   /whoami
   ```

**More help:** [Troubleshooting →](/cli/troubleshooting)

## Getting Help

- **Command help**: Type `/help` in the CLI
- **Documentation**: [B4M CLI Docs](https://docs.bike4mind.com/cli)
- **Issues**: [GitHub Issues](https://github.com/bike4mind/bike4mind/issues)
- **Web App**: [app.bike4mind.com](https://app.bike4mind.com)

---

**Ready to dive deeper?** Check out the [Features Guide →](/cli/features) or explore [Configuration Options →](/cli/configuration)
