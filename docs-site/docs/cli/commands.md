---
title: Commands Reference
description: Complete reference for all B4M CLI commands
sidebar_position: 3
---

# Commands Reference

Complete reference for all slash commands available in B4M CLI.

Slash commands are special commands that start with `/` and control the CLI's behavior rather than sending messages to the AI agent.

## Quick Reference

| Command | Description |
|---------|-------------|
| `/login` | Authenticate with Bike4Mind |
| `/logout` | Sign out and clear tokens |
| `/whoami` | Show current user |
| `/sessions` | List saved sessions |
| `/save <name>` | Save current session |
| `/clear` | Start a new session |
| `/rewind` | Rewind conversation to previous point |
| `/set-api <url>` | Connect to self-hosted instance |
| `/reset-api` | Reset to default API |
| `/api-info` | Show API configuration |
| `/trust <tool>` | Trust a tool |
| `/untrust <tool>` | Remove tool from trusted list |
| `/trusted` | List trusted tools |
| `/mcp` | Show MCP server status |
| `/usage` | Show credit usage and balance |
| `/config` | Open configuration editor |
| `/commands` | List custom commands |
| `/commands:new <name>` | Create custom command |
| `/commands:reload` | Reload custom commands from disk |
| `/project-config` | Show merged project configuration |
| `/sandbox` | Show sandbox status |
| `/sandbox:enable` | Enable OS-level sandbox |
| `/sandbox:disable` | Disable sandbox |
| `/sandbox:mode <mode>` | Set sandbox mode |
| `/sandbox:trust-domain <domain>` | Trust a network domain |
| `/sandbox:domains` | Show allowed domains |
| `/sandbox:violations` | Show recent violations |
| `/sandbox:violations:clear` | Clear violation log |
| `/help` | Show help |
| `/exit` | Exit CLI |

---

## Authentication Commands

### `/login`

Initiate OAuth authentication flow with Bike4Mind.

**Usage:**
```bash
/login
```

**What happens:**
1. Displays device authorization screen
2. **Automatically opens browser** with activation URL
3. Code is **prepopulated** in the browser
4. You verify the code and click "Approve"
5. CLI detects authorization and stores tokens

**Example:**
```bash
> /login

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

✓ Authentication successful!
Logged in as: john@example.com
```

**When to use:**
- First time running the CLI (required for AI features)
- After logging out
- When tokens expire (though auto-refresh usually handles this)
- Switching accounts

---

### `/logout`

Sign out and clear authentication tokens.

**Usage:**
```bash
/logout
```

**What happens:**
- Removes access and refresh tokens from config
- Clears user information
- Requires re-authentication to continue

**Example:**
```bash
> /logout

✓ Logged out successfully
You'll need to authenticate again to continue.
```

**When to use:**
- Switching to a different account
- Security: removing credentials from shared machine
- Troubleshooting authentication issues

---

### `/whoami`

Display information about the currently authenticated user.

**Usage:**
```bash
/whoami
```

**Example:**
```bash
> /whoami

Authenticated as:
  Email: john@example.com
  User ID: usr_abc123
  API Endpoint: https://app.bike4mind.com/api
  Token Status: Valid (expires in 89 days)
```

**When to use:**
- Verifying you're logged in
- Checking which account is active
- Confirming API endpoint configuration
- Debugging authentication issues

---

## Session Management Commands

### `/sessions`

List all saved sessions with metadata.

**Usage:**
```bash
/sessions
```

**Example:**
```bash
> /sessions

Saved Sessions:
  1. project-work (3 hours ago, 42 messages)
  2. research-notes (1 day ago, 18 messages)
  3. code-review (3 days ago, 27 messages)
  4. debugging-session (1 week ago, 56 messages)
```

**Session Information Shown:**
- Session name
- Last modified time
- Number of messages
- Token usage (if available)

**When to use:**
- Finding a previous conversation
- Managing saved work
- Checking session history

---

### `/save <name>`

Save the current conversation session.

**Usage:**
```bash
/save <session-name>
```

**Arguments:**
- `session-name` - Name for the saved session (alphanumeric, hyphens, underscores)

**Example:**
```bash
> /save my-project-work

✓ Session saved as: my-project-work
Location: ~/.bike4mind/sessions/my-project-work.json
```

**What gets saved:**
- Full conversation history
- Tool execution results
- Agent reasoning steps
- Token usage statistics
- Metadata (timestamp, model, etc.)

**When to use:**
- End of a work session
- Before switching tasks
- Preserving important conversations
- Creating checkpoints

**Tips:**
- Use descriptive names: `typescript-migration`, `bug-investigation`
- Save early and often
- Sessions are deduplicated by name (overwrites existing)

---

### `/clear`

Start a new conversation session (clears current context).

**Usage:**
```bash
/clear
```

**Example:**
```bash
> /clear

✓ Session cleared
Starting fresh conversation.
```

**What happens:**
- Clears current conversation history
- Resets context (agent forgets previous messages)
- Starts a new session with empty state

**When to use:**
- Switching to a completely different topic
- Starting fresh after a long conversation
- Clearing context to avoid confusion
- Before working on unrelated tasks

**Note:** Consider using `/save` before `/clear` to preserve your work.

---

### `/rewind`

Rewind the conversation to a previous point.

**Usage:**
```bash
/rewind
```

**Example:**
```bash
> /rewind

Select a point to rewind to:
  1. Before last agent response (2 messages ago)
  2. Before last 5 messages
  3. Custom...

> 1

✓ Conversation rewound to 2 messages ago
You can now continue from this point.
```

**What happens:**
- Removes recent messages from conversation history
- Returns to an earlier state in the conversation
- Allows you to branch in a different direction

**When to use:**
- Agent made a mistake and you want to retry
- Conversation went in the wrong direction
- Testing different approaches to a problem
- Undoing recent exchanges

---

## API Configuration Commands

### `/set-api <url>`

Connect to a self-hosted Bike4Mind instance.

**Usage:**
```bash
/set-api <api-url>
```

**Arguments:**
- `api-url` - Base URL of your Bike4Mind instance (must include `https://`)

**Example:**
```bash
> /set-api https://b4m.company.com

✓ API endpoint updated
New endpoint: https://b4m.company.com/api

You'll need to re-authenticate with this instance.
```

**What happens:**
1. Updates `apiUrl` in config
2. Clears existing authentication tokens
3. Prompts for re-authentication

**When to use:**
- Your organization runs a self-hosted instance
- Using a dedicated enterprise deployment
- Testing against a staging environment

**Security Note:** Only connect to trusted instances you control.

---

### `/reset-api`

Reset API endpoint to the default Bike4Mind service.

**Usage:**
```bash
/reset-api
```

**Example:**
```bash
> /reset-api

✓ API endpoint reset to default
Endpoint: https://app.bike4mind.com/api

You'll need to re-authenticate.
```

**What happens:**
- Resets `apiUrl` to `https://app.bike4mind.com`
- Clears authentication tokens
- Prompts for re-authentication

**When to use:**
- Returning to the main service after using self-hosted
- Fixing misconfigured API endpoint
- Troubleshooting connection issues

---

### `/api-info`

Display current API configuration.

**Usage:**
```bash
/api-info
```

**Example:**
```bash
> /api-info

API Configuration:
  Endpoint: https://app.bike4mind.com/api
  Status: Connected
  Authentication: Valid
  Last Checked: 2 minutes ago

Limits:
  Rate Limit: 100 requests/minute
  Max Context: 200k tokens
```

**Information Shown:**
- Current API endpoint
- Connection status
- Authentication state
- Rate limits (if available)
- Feature availability

**When to use:**
- Verifying configuration
- Debugging connection issues
- Checking which instance you're connected to

---

## Tool Permission Commands

### `/trust <tool>`

Add a tool to the trusted list (won't ask permission again).

**Usage:**
```bash
/trust <tool-name>
```

**Arguments:**
- `tool-name` - Name of the tool to trust (e.g., `bash_execute`, `web_search`)

**Example:**
```bash
> /trust bash_execute

✓ Tool trusted: bash_execute
This tool will now execute automatically without permission prompts.

To remove: /untrust bash_execute
```

**What happens:**
- Adds tool to `trustedTools` in config
- Future executions of this tool won't prompt for permission
- Permission prompts will show "Automatically allowed (trusted)"

**When to use:**
- You use a tool frequently and trust it
- Streamlining workflow (e.g., trusting `bash_execute` for dev work)
- After verifying a tool behaves as expected

**Safety Tips:**
- Only trust tools you fully understand
- Be cautious with tools that modify files or run commands
- Review what a tool does before trusting it

---

### `/untrust <tool>`

Remove a tool from the trusted list.

**Usage:**
```bash
/untrust <tool-name>
```

**Arguments:**
- `tool-name` - Name of the tool to untrust

**Example:**
```bash
> /untrust bash_execute

✓ Tool untrusted: bash_execute
This tool will now require permission before executing.
```

**What happens:**
- Removes tool from `trustedTools` in config
- Future executions will prompt for permission
- Does not affect other tools

**When to use:**
- You want more control over a tool
- Security: requiring explicit permission
- A tool behaved unexpectedly

---

### `/trusted`

List all currently trusted tools.

**Usage:**
```bash
/trusted
```

**Example:**
```bash
> /trusted

Trusted Tools (no permission required):
  ✓ bash_execute - Execute shell commands
  ✓ web_search - Search the web
  ✓ weather_info - Get weather information

To remove trust: /untrust <tool-name>
```

**Information Shown:**
- Tool name
- Tool description
- How to untrust

**When to use:**
- Reviewing security settings
- Checking which tools auto-execute
- Auditing trusted tools list

---

## MCP Commands

### `/mcp`

Show status of configured and connected MCP (Model Context Protocol) servers.

**Usage:**
```bash
/mcp
```

**Aliases:** `/mcp:list`

**Example:**
```bash
> /mcp

📡 Configured MCP Servers:

• context7 - ✅ Enabled
  Command: npx -y @upstash/context7-mcp

• github - ⏸️  Disabled
  Command: docker run -i ghcr.io/modelcontextprotocol/servers/github
  Env vars: GITHUB_TOKEN

🔌 Connected & Active:

• context7: 2 tools

Total: 2 MCP tools available
```

**What it shows:**
- **Configured servers:** All MCP servers defined in your config
- **Status:** Whether each server is enabled (✅) or disabled (⏸️)
- **Command:** The command used to start each server
- **Environment variables:** API keys and config vars (names only, values hidden)
- **Connected servers:** Servers that successfully started and connected
- **Tool count:** Number of tools available from each connected server

**Related:**
- See [MCP Integration](/cli/mcp-integration) for complete MCP setup guide
- Use `b4m mcp add` to add new MCP servers (external command)
- Use `b4m mcp remove` to remove servers (external command)
- Use `b4m mcp enable/disable` to toggle servers (external command)

**When to use:**
- Verifying MCP servers loaded successfully
- Checking how many tools are available
- Debugging MCP connection issues
- Confirming server configuration

**Troubleshooting:**
- If a server is enabled but not connected, check debug logs: `b4m --verbose`
- If no tools appear, verify the server command is correct
- For Docker servers, ensure Docker is running: `docker ps`

---

## Utility Commands

### `/config`

Display current CLI configuration.

**Usage:**
```bash
/config
```

**Example:**
```bash
> /config

Configuration (~/.bike4mind/config.json):

Authentication:
  User: john@example.com
  API Endpoint: https://app.bike4mind.com/api
  Token Status: Valid

Trusted Tools:
  - bash_execute
  - web_search

MCP Servers:
  ✓ github (enabled)
  ✗ atlassian (disabled)

Tool API Keys:
  ✓ serper (configured)
  ✓ openweather (configured)

Storage:
  Sessions: ~/.bike4mind/sessions/
  Debug Logs: ~/.bike4mind/debug/
```

**Information Shown:**
- Authentication status
- API configuration
- Trusted tools
- MCP servers status
- Configured API keys
- File locations

**When to use:**
- Reviewing your setup
- Debugging configuration issues
- Checking what's enabled/disabled

---

### `/usage`

Show credit usage and balance information.

**Usage:**
```bash
/usage
```

**Example:**
```bash
> /usage

Credit Usage:
  Current Balance: 1,250 credits
  Used This Month: 3,420 credits

Recent Usage:
  Today: 145 credits (12 requests)
  Yesterday: 198 credits (15 requests)
  This Week: 847 credits (68 requests)

Average per Request: 28.5 credits
Estimated Monthly Usage: ~4,200 credits
```

**Information Shown:**
- Current credit balance
- Credits used this month
- Recent usage breakdown
- Average credits per request
- Usage projections

**When to use:**
- Checking remaining credits
- Monitoring usage patterns
- Planning budget
- Identifying high-usage activities

---

### `/help`

Show help information and available commands.

**Usage:**
```bash
/help
```

**Example:**
```bash
> /help

B4M CLI - Interactive AI Assistant

Available Commands:
  Authentication:
    /login              - Authenticate with Bike4Mind
    /logout             - Sign out
    /whoami             - Show current user

  Session Management:
    /sessions           - List saved sessions
    /save <name>        - Save current session

  [... more commands ...]

For detailed documentation: https://docs.bike4mind.com/cli
```

**When to use:**
- Forgot a command
- Quick reference
- Finding available commands

---

### `/exit`

Exit the CLI application.

**Usage:**
```bash
/exit
```

**Alternatives:**
- Press `Ctrl+C` (sends SIGINT)
- Press `Ctrl+D` (EOF)
- Close terminal window

**Example:**
```bash
> /exit

Goodbye! 👋
```

**What happens:**
- Saves current session state (if applicable)
- Closes all connections
- Exits process gracefully

**When to use:**
- Ending your CLI session
- Switching to a different task

**Tip:** Consider using `/save` before exiting to preserve your conversation.

---

## Custom Commands

### `/commands`

List all custom commands available in your project.

**Usage:**
```bash
/commands
```

**Example:**
```bash
> /commands

Custom Commands:
  /review-pr <number>     - Review a pull request
  /deploy-staging         - Deploy to staging environment
  /run-tests              - Run test suite
  /check-deps             - Check for outdated dependencies

Location: .claude/commands/

To create new command: /commands:new <name>
```

**What's shown:**
- Command name and usage
- Brief description
- Location of command files

**When to use:**
- Discovering available project commands
- Checking command syntax
- Finding project-specific workflows

**Note:** Custom commands are loaded from `.claude/commands/` directory in your project.

---

### `/commands:new <name>`

Create a new custom command.

**Usage:**
```bash
/commands:new <command-name>
```

**Arguments:**
- `command-name` - Name for the new command (alphanumeric, hyphens)

**Example:**
```bash
> /commands:new review-pr

✓ Created new command: review-pr
Location: .claude/commands/review-pr.md

The file has been created and opened for editing.
Add your command instructions in Markdown format.

Example content:
---
description: Review a pull request
---

Review pull request #{{arg1}}:
1. Check the diff
2. Review for code quality
3. Test the changes
4. Provide feedback
```

**What happens:**
1. Creates `.claude/commands/` directory if it doesn't exist
2. Creates `<command-name>.md` file
3. Opens file for editing (if possible)
4. Command becomes available immediately after saving

**File Format:**
```markdown
---
description: Brief description of what this command does
---

Instructions for the AI agent when this command runs.
You can use {{arg1}}, {{arg2}}, etc. for arguments.
```

**When to use:**
- Creating project-specific workflows
- Automating repetitive tasks
- Sharing commands with team
- Building custom shortcuts

**Tips:**
- Use descriptive names: `/deploy-staging`, `/review-pr`
- Include clear instructions in the command file
- Use arguments for flexibility: `{{arg1}}`, `{{arg2}}`
- Commit commands to version control for team sharing


---

### `/commands:reload`

Reload custom commands from disk without restarting the CLI.

**Usage:**
```bash
/commands:reload
```

**Example:**
```bash
> /commands:reload

✓ Reloaded custom commands
Found 3 custom commands:
  - /review-pr
  - /deploy-staging
  - /run-tests
```

**What happens:**
- Scans `.claude/commands/` directory for command files
- Reloads all `.md` files as custom commands
- Updates command list for autocomplete
- Makes new/modified commands immediately available

**When to use:**
- After creating new command files manually
- After editing existing command files
- When commands aren't showing up in `/commands` list
- Testing command file changes without CLI restart

---

### `/project-config`

Display the merged project configuration showing all active settings.

**Usage:**
```bash
/project-config
```

**Example:**
```bash
> /project-config

Project Configuration:
  Context Files:
    - CLAUDE.md (project, 1.2 KB)
    - ~/.bike4mind/AI.md (global, 0.8 KB)

  Custom Commands: 3 loaded
    - /review-pr (project)
    - /deploy-staging (project)
    - /check-deps (global)

  MCP Servers:
    ✓ github (enabled)
    ✗ atlassian (disabled)
```

**Information Shown:**
- Active context files (project and global)
- Custom commands and their sources
- MCP server status
- Configuration file locations
- Merged settings from all sources

**When to use:**
- Verifying which context files are loaded
- Debugging configuration issues
- Checking if custom commands are registered
- Understanding effective configuration for current project

---

## Sandbox Commands

The sandbox provides OS-level isolation for bash commands. These commands control filesystem restrictions, network filtering, and violation monitoring.

| Command | Description |
|---------|-------------|
| `/sandbox` | Show sandbox status, platform, proxy, and session stats |
| `/sandbox:enable` | Enable sandbox in auto-allow mode |
| `/sandbox:disable` | Disable sandbox and stop proxy |
| `/sandbox:mode <mode>` | Switch between `auto-allow` and `permissions` modes |
| `/sandbox:trust-domain <domain>` | Add domain(s) to network proxy allowlist |
| `/sandbox:domains` | List all allowed network domains |
| `/sandbox:violations [count]` | Show recent violations (default: 20) |
| `/sandbox:violations:clear` | Clear violation log and reset stats |

For detailed sandbox command documentation, see [Sandbox Commands →](/cli/sandbox/commands).

---

## Advanced Usage

### Command History

Future feature: Navigate previous commands with `↑` and `↓` arrow keys.

```bash
# Coming soon
↑  # Previous command
↓  # Next command
```

### Command Chaining

You cannot chain slash commands. Each command must be entered separately:

```bash
# ❌ Won't work
> /save my-work /exit

# ✅ Correct
> /save my-work
✓ Session saved
> /exit
```

### Aliases

Several commands have aliases for convenience:

```bash
# Available aliases
/quit           → /exit
/new            → /clear
/undo           → /rewind
```

**Example usage:**
```bash
# These are equivalent
/exit
/quit

# These are equivalent
/clear
/new

# These are equivalent
/rewind
/undo
```

---

## Command Tips

### Case Sensitivity

Commands are case-insensitive:

```bash
/login    # ✓ Works
/LOGIN    # ✓ Works
/Login    # ✓ Works
```

### Spacing

Extra spaces are ignored:

```bash
/save my-work           # ✓ Works
/save   my-work         # ✓ Works
/save     my-work       # ✓ Works
```

### Incomplete Commands

If you forget arguments, the CLI will prompt you:

```bash
> /save
Error: Session name required
Usage: /save <session-name>
```

### Unknown Commands

Unknown commands show an error:

```bash
> /unknown
Error: Unknown command: /unknown
Type /help for available commands
```

---

## See Also

- [Configuration →](/cli/configuration) - Customize your CLI experience
- [Features Guide →](/cli/features) - Deep dive into CLI capabilities
- [Troubleshooting →](/cli/troubleshooting) - Common issues and solutions
