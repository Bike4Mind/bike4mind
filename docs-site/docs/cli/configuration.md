---
title: Configuration
description: Configure and customize the B4M CLI
sidebar_position: 4
---

# Configuration

Learn how to configure and customize B4M CLI to fit your workflow.

## Configuration File

All configuration is stored in `~/.bike4mind/config.json`.

**Location:**
- macOS/Linux: `~/.bike4mind/config.json`
- Windows: `%USERPROFILE%\.bike4mind\config.json`

**Permissions:**
- File mode: `0600` (readable/writable by owner only)
- Contains sensitive data (API keys, tokens)

### View Current Configuration

```bash
# In CLI
/config

# Or inspect file directly
cat ~/.bike4mind/config.json
```

### Example Configuration

```json
{
  "apiUrl": "https://app.bike4mind.com",
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "user": {
    "email": "john@example.com",
    "userId": "usr_abc123"
  },
  "trustedTools": ["bash_execute", "web_search"],
  "toolApiKeys": {
    "serper": "your-serper-api-key",
    "openweather": "your-openweather-api-key"
  },
  "mcpServers": [
    {
      "name": "github",
      "enabled": true,
      "env": {
        "GITHUB_ACCESS_TOKEN": "ghp_..."
      }
    }
  ]
}
```

---

## Authentication

### OAuth Tokens

Automatically managed after running `/login`:

**Fields:**
- `accessToken` - Short-lived access token (used for API requests)
- `refreshToken` - Long-lived refresh token (used to get new access tokens)
- `user.email` - Your email address
- `user.userId` - Your user ID

**Token Lifecycle:**
- Access tokens expire after 90 days
- Refresh tokens expire after 1 year
- CLI automatically refreshes expired access tokens
- If refresh fails, you'll be prompted to `/login` again

### Custom API Endpoint

For self-hosted instances:

```bash
# Set custom endpoint
/set-api https://b4m.yourcompany.com

# Reset to default
/reset-api
```

**Manual configuration:**

```json
{
  "apiUrl": "https://b4m.yourcompany.com"
}
```

---

## Tool API Keys

**Good news:** B4M CLI's server-side tools (`weather_info`, `web_search`) use B4M's company API keys. No configuration needed!

### Server-Side Tools (No Keys Required)

These tools run on B4M servers with company API keys:

| Tool | Description | Key Required |
|------|-------------|--------------|
| `weather_info` | Get current weather | ❌ No (uses B4M keys) |
| `web_search` | Search the web | ❌ No (uses B4M keys) |

**You don't need to configure API keys for these tools.**

### Local Tools (No Keys Required)

All local tools execute without external API keys:

| Tool | Description |
|------|-------------|
| `file_read` | Read file contents |
| `create_file` | Create new files |
| `edit_local_file` | Edit existing files |
| `glob_files` | Find files by pattern |
| `grep_search` | Search file contents |
| `delete_file` | Delete files |
| `dice_roll` | Roll dice |
| `math_evaluate` | Evaluate math expressions |
| `current_datetime` | Get current date/time |
| `bash_execute` | Execute shell commands |

**None of these require API keys or configuration.**

---

## Tool Permissions

Control which tools can execute automatically vs. requiring permission.

### Trusted Tools

Tools in the `trustedTools` array execute without asking permission:

```json
{
  "trustedTools": [
    "bash_execute",
    "web_search",
    "weather_info"
  ]
}
```

### Manage Trusted Tools

```bash
# View trusted tools
/trusted

# Trust a tool (add to list)
/trust bash_execute

# Untrust a tool (remove from list)
/untrust bash_execute
```

### Permission Prompt

When a non-trusted tool tries to execute:

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ ⚠️ Permission Required                      ┃
┃                                            ┃
┃ Tool: bash_execute                         ┃
┃                                            ┃
┃ Arguments:                                 ┃
┃   { "command": "ls -la /home" }            ┃
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

### Safety Recommendations

✅ **Safe to trust:**
- `dice_roll` - Random number generation
- `math_evaluate` - Safe mathematical calculations
- `current_datetime` - Read-only date/time info
- `file_read` - Read-only file access
- `glob_files` - Read-only file searching
- `grep_search` - Read-only content searching

⚠️ **Use caution:**
- `bash_execute` - Can run any shell command
- `web_search` - Makes external HTTP requests
- `weather_info` - Makes external API calls
- `create_file` - Creates new files
- `edit_local_file` - Modifies existing files

🛑 **Rarely trust (review each time):**
- `delete_file` - Permanently deletes files
- MCP tools with file write access
- Tools that modify system state
- Tools from unknown sources

---

## Context Files

B4M CLI automatically loads project-specific instructions from context files.

### Supported Files

The CLI looks for these files in your current directory (priority order):

1. `CLAUDE.local.md` - Personal instructions (gitignored)
2. `CLAUDE.md` - Project instructions (committed)
3. `AGENTS.md` - Cross-tool standard
4. `AI.local.md` - Personal instructions
5. `AI.md` - Project instructions
6. `INSTRUCTIONS.md` - Project instructions (lowest priority)

**Global context files** (in `~/.bike4mind/`):
1. `AI.local.md` - Personal global instructions
2. `AI.md` - Global instructions

### How It Works

- CLI loads the **first matching file** from each layer (global and project)
- Project files take precedence over global files
- Only one file from each layer is loaded
- `.local.md` files are for personal preferences (add to `.gitignore`)

**Example startup:**

```bash
$ b4m

📄 Global context: ~/.bike4mind/AI.md
📄 Project context: CLAUDE.md

>
```

### Create a Context File

**For a specific project:**

```bash
cat > CLAUDE.md << 'EOF'
# TypeScript Project Instructions

## Code Style
- Use TypeScript strict mode
- Prefer functional components with hooks
- Follow existing patterns in codebase

## Testing
- Write tests for new features
- Run `pnpm test` before committing

## Documentation
- Update README for user-facing changes
- Add JSDoc comments to exported functions
EOF
```

**For all your projects (global):**

```bash
cat > ~/.bike4mind/AI.md << 'EOF'
# Personal AI Assistant Preferences

- Always explain your reasoning
- Provide code examples when relevant
- Use clear, concise language
- Ask clarifying questions when uncertain
EOF
```

### Context File Limits

- Maximum size: 100 KB per file
- Symlinks are rejected for security
- Must be valid UTF-8 text
- Markdown formatting recommended (but not required)

### Best Practices

✅ **Do:**
- Use descriptive, actionable instructions
- Keep it concise and focused
- Use `.local.md` for personal preferences
- Commit project-level instructions (e.g., `CLAUDE.md`)
- Update as project standards evolve

❌ **Don't:**
- Include sensitive information (API keys, credentials)
- Make files too large (keep under 10KB when possible)
- Use as a dump for everything (be selective)
- Duplicate instructions between global and project files

### Example Use Cases

**Project-specific coding standards:**
```markdown
# API Development Guidelines

- Use REST conventions
- Validate all inputs with Zod
- Return errors as `{ error: string }`
- Include request ID in logs
```

**Team workflow:**
```markdown
# PR Review Checklist

Before requesting review:
- [ ] Tests pass locally
- [ ] No TypeScript errors
- [ ] Updated CHANGELOG.md
- [ ] Added documentation
```

**Personal preferences:**
```markdown
# My Preferences

- I prefer async/await over promises
- Explain complex algorithms step-by-step
- Suggest improvements even when not asked
```

---

## MCP Servers

See [MCP Integration →](/cli/mcp-integration) for complete documentation.

**Quick reference:**

```json
{
  "mcpServers": [
    {
      "name": "github",
      "enabled": true,
      "env": {
        "GITHUB_ACCESS_TOKEN": "ghp_..."
      }
    }
  ]
}
```

---

## Debug Logging

### Automatic Debug Logs

Debug logs are **always** written to `~/.bike4mind/debug/[session-id].txt`.

**What's logged:**
- Session configuration
- HTTP requests/responses
- SSE streaming events
- Tool execution details
- Error diagnostics
- Authentication flow

**Location:**
```bash
~/.bike4mind/debug/
├── abc123-session-id.txt
├── def456-session-id.txt
└── ...
```

**Retention:**
- Logs older than 30 days are auto-deleted on CLI startup
- You can manually delete logs anytime

### Verbose Console Output

Enable verbose output with `--verbose` or `-v`:

```bash
b4m --verbose
```

This shows debug logs in the console in addition to writing to file.

**Use verbose when:**
- Debugging issues in real-time
- Developing integrations
- Troubleshooting tool execution
- Investigating API errors

### View Debug Logs

```bash
# List all debug logs
ls -lh ~/.bike4mind/debug/

# View latest log
cat ~/.bike4mind/debug/*.txt | tail -n 100

# Follow logs in real-time (during session)
tail -f ~/.bike4mind/debug/[session-id].txt
```

---

## Storage Locations

### Directory Structure

```
~/.bike4mind/
├── config.json              # Main configuration (0600 permissions)
├── sessions/                # Saved conversations
│   ├── my-work.json
│   ├── debugging.json
│   └── research.json
├── debug/                   # Debug logs (auto-cleanup after 30 days)
│   ├── abc123.txt
│   └── def456.txt
└── images/                  # Cached images (if image rendering enabled)
    ├── img-001.png
    └── img-002.jpg
```

### Backup Configuration

To backup your configuration:

```bash
# Backup
cp ~/.bike4mind/config.json ~/.bike4mind/config.backup.json

# Restore
cp ~/.bike4mind/config.backup.json ~/.bike4mind/config.json
```

### Reset to Defaults

To start fresh:

```bash
# Remove all configuration and data
rm -rf ~/.bike4mind/

# Remove configuration only (keep sessions)
rm ~/.bike4mind/config.json
```

**Note:** You'll need to re-authenticate after removing config.

---

## Environment Variables

B4M CLI respects these environment variables:

| Variable | Purpose | Example |
|----------|---------|---------|
| `B4M_API_URL` | Override default API endpoint | `https://b4m.company.com` |
| `B4M_VERBOSE` | Enable verbose logging | `1` or `true` |
| `OPENWEATHER_API_KEY` | OpenWeather API key | `abc123...` |
| `SERPER_API_KEY` | Serper API key | `xyz789...` |
| `NO_COLOR` | Disable colored output | `1` |

**Set environment variables:**

```bash
# Temporary (current session)
export B4M_VERBOSE=1
b4m

# Permanent (add to ~/.bashrc or ~/.zshrc)
echo 'export B4M_VERBOSE=1' >> ~/.zshrc
```

---

## Configuration Precedence

When multiple configuration sources exist, this is the precedence (highest to lowest):

1. **Command-line flags** (e.g., `--verbose`)
2. **Environment variables** (e.g., `B4M_API_URL`)
3. **Config file** (`~/.bike4mind/config.json`)
4. **Built-in defaults**

**Example:**
- Config file has `apiUrl: "https://example.com"`
- Environment has `B4M_API_URL=https://custom.com`
- Result: CLI uses `https://custom.com` (env overrides config)

---

## Advanced Configuration

### Custom Session Directory

Not currently supported, but planned:

```json
{
  "sessionDir": "/custom/path/to/sessions"
}
```

### Model Selection

Not currently supported via config, but planned:

```json
{
  "model": "claude-3-opus-20240229",
  "temperature": 0.7,
  "maxTokens": 4096
}
```

---

## Troubleshooting Configuration

### Config File Corruption

If your config is corrupted:

```bash
# Backup corrupt file
mv ~/.bike4mind/config.json ~/.bike4mind/config.broken.json

# Let CLI recreate defaults
b4m
```

### Permission Errors

Fix file permissions:

```bash
# Correct permissions for config
chmod 600 ~/.bike4mind/config.json

# Correct permissions for directory
chmod 700 ~/.bike4mind/
```

### Invalid JSON

Validate your config file:

```bash
# Check if JSON is valid
cat ~/.bike4mind/config.json | jq .

# If jq not installed
python3 -m json.tool ~/.bike4mind/config.json
```

---

## See Also

- [Commands Reference →](/cli/commands) - All available commands
- [MCP Integration →](/cli/mcp-integration) - Setting up MCP servers
- [Troubleshooting →](/cli/troubleshooting) - Common issues and solutions
- [Advanced Usage →](/cli/advanced-usage) - Best practices and tips
