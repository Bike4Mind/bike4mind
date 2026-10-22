---
title: Features Guide
description: Deep dive into B4M CLI capabilities
sidebar_position: 6
---

# Features Guide

Comprehensive guide to all B4M CLI features and capabilities.

## ReAct Agent System

B4M CLI uses a **Reasoning and Acting (ReAct)** agent that thinks through problems step-by-step before executing actions.

### How It Works

```
User: "Find all TODO comments in TypeScript files"
  ↓
Agent Reasoning:
  1. Need to search for "TODO" in files
  2. Should filter for .ts and .tsx files
  3. Use bash command with grep
  ↓
Agent Action:
  [tool: bash_execute]
  grep -r "TODO" --include="*.ts" --include="*.tsx" .
  ↓
Agent Response:
  Found 12 TODO comments:
  - src/app.ts:42 - TODO: Add error handling
  - src/utils.ts:15 - TODO: Optimize performance
  ... (more results)
```

### Thought Stream

See the agent's reasoning in real-time:

```
> What's the capital of France and what's the weather there?

💭 Thinking...
Step 1: First, I'll answer the capital question
Step 2: Then I'll fetch weather for Paris
Step 3: Combine both pieces of information

[executing...]

The capital of France is Paris.

[tool: weather_info location="Paris"]

Current weather in Paris:
- Temperature: 18°C (64°F)
- Conditions: Partly cloudy
```

### Multi-Step Planning

The agent can break down complex tasks:

```
> Create a new React component for a user profile card

💭 Planning task breakdown:
1. Create component file
2. Add TypeScript interface for props
3. Implement component JSX
4. Add basic styling
5. Export from index

[Executes each step sequentially...]
```

---

## Built-in Tools

B4M CLI includes two types of tools: **server-side tools** (executed via B4M API with company keys) and **local tools** (executed in your CLI).

### Server-Side Tools

These tools run on B4M servers using company API keys. No local configuration required.

#### `web_search`

Search the web for information.

```bash
> Search for latest React 19 features
[tool: web_search query="React 19 new features 2025"]

Top results:
1. **React 19 Release Notes**
   - New: Actions API
   - New: useOptimistic hook
   - Improved: Server Components
   ...
```

**Note:** Uses B4M's company API keys (no configuration needed)

---

#### `weather_info`

Get current weather for any location.

```bash
> Weather in Tokyo
[tool: weather_info location="Tokyo"]

Tokyo, Japan:
- Temperature: 12°C (54°F)
- Conditions: Clear
- Humidity: 45%
- Wind: 5 mph NE
- Pressure: 1013 hPa

> Will it rain in London today?
[tool: weather_info location="London"]
[Analyzes weather data]

No significant rain expected in London today. Partly cloudy with temps around 15°C.
```

**Note:** Uses B4M's company API keys (no configuration needed)

---

### Local Tools

These tools execute locally in your CLI process.

#### File Operation Tools

##### `file_read`

Read contents of a file.

```bash
> Read the package.json file
[tool: file_read path="package.json"]

{
  "name": "my-project",
  "version": "1.0.0",
  ...
}
```

##### `create_file`

Create a new file with content.

```bash
> Create a new README.md file
[tool: create_file path="README.md" content="# My Project\n\nDescription here"]

✓ Created: README.md
```

##### `edit_local_file`

Edit an existing file.

```bash
> Update the version in package.json to 2.0.0
[tool: edit_local_file path="package.json" ...]

✓ Updated: package.json
```

##### `glob_files`

Find files matching a pattern.

```bash
> Find all TypeScript files
[tool: glob_files pattern="**/*.ts"]

Found 42 files:
- src/index.ts
- src/app.ts
- src/utils.ts
...
```

##### `grep_search`

Search file contents for text.

```bash
> Search for TODO comments in TypeScript files
[tool: grep_search pattern="TODO" files="**/*.ts"]

Found 12 matches:
- src/app.ts:42 - TODO: Add error handling
- src/utils.ts:15 - TODO: Optimize performance
...
```

##### `delete_file`

Delete a file.

```bash
> Delete the old config file
[tool: delete_file path="old-config.json"]

✓ Deleted: old-config.json
```

---

#### Math & Logic Tools

##### `dice_roll`

Roll dice with standard notation.

```bash
> Roll 2d6
[tool: dice_roll sides=6 count=2]
Rolled: 4, 5 (total: 9)

> Roll 3d20
[tool: dice_roll sides=20 count=3]
Rolled: 12, 19, 7 (total: 38)
```

##### `math_evaluate`

Evaluate mathematical expressions.

```bash
> Calculate (42 * 8) + sqrt(144)
[tool: math_evaluate expression="(42 * 8) + sqrt(144)"]
Result: 348

> What's 2^10?
[tool: math_evaluate expression="2^10"]
Result: 1024
```

---

#### Date & Time Tools

##### `current_datetime`

Get current date and time.

```bash
> What time is it?
[tool: current_datetime]
Current: 2025-01-14 15:30:45 UTC
(Your timezone: 2025-01-14 10:30:45 EST)

> What day of the week is it?
[tool: current_datetime]
Today is Tuesday, January 14, 2025
```

---

#### Shell Tools

##### `bash_execute`

Execute shell commands.

```bash
> List all Python files in this directory
[tool: bash_execute command="find . -name '*.py'"]

./src/main.py
./tests/test_utils.py
./scripts/deploy.py

> What's my current git branch?
[tool: bash_execute command="git branch --show-current"]
feature/user-auth
```

**Safety:**
- Requires permission on first use
- Shows full command before execution
- Can be trusted for automatic execution

---

## Session Management

### Saving Sessions

Preserve conversations for later:

```bash
# Save current session
/save typescript-migration

✓ Session saved: typescript-migration
Location: ~/.bike4mind/sessions/typescript-migration.json
```

**What's saved:**
- Full conversation history
- All messages (user and agent)
- Tool execution results
- Agent reasoning steps
- Tokens used
- Timestamp and metadata

### Listing Sessions

View all saved sessions:

```bash
/sessions

Saved Sessions:
  1. typescript-migration (2 hours ago, 38 messages, 12.5K tokens)
  2. bug-investigation (1 day ago, 15 messages, 4.2K tokens)
  3. api-design (3 days ago, 52 messages, 18.9K tokens)
```

### Session Files

Sessions are stored as JSON:

```json
{
  "id": "sess_abc123",
  "name": "typescript-migration",
  "messages": [
    {
      "role": "user",
      "content": "Help me migrate to TypeScript"
    },
    {
      "role": "assistant",
      "content": "I'll help you migrate...",
      "reasoning": "...",
      "toolCalls": [...]
    }
  ],
  "metadata": {
    "createdAt": "2025-01-14T10:00:00Z",
    "updatedAt": "2025-01-14T12:30:00Z",
    "tokenCount": 12500,
    "model": "claude-3-opus"
  }
}
```

**Location:** `~/.bike4mind/sessions/`

---

## Context Files

### Project Instructions

Load project-specific instructions automatically:

**Create `CLAUDE.md` in your project:**

```markdown
# Project Guidelines

## Architecture
- This is a Next.js 13 app with App Router
- Use Server Components by default
- Client Components only when needed

## Code Style
- TypeScript strict mode required
- Prefer composition over inheritance
- Use Zod for validation

## Testing
- Jest for unit tests
- Cypress for E2E tests
- Minimum 80% coverage
```

**CLI loads it automatically:**

```bash
cd /path/to/project
b4m

📄 Project context: CLAUDE.md

> [Agent now follows project guidelines]
```

### Global Instructions

Set personal preferences for all projects:

**Create `~/.bike4mind/AI.md`:**

```markdown
# My Preferences

- I prefer async/await over .then()
- Always explain complex code
- Suggest optimizations when relevant
- Use concrete examples
```

**Loaded for every session:**

```bash
b4m

📄 Global context: ~/.bike4mind/AI.md

> [Agent follows your preferences everywhere]
```

### Priority Order

When multiple context files exist:

1. **Project files** (highest priority):
   - `CLAUDE.local.md` (gitignored, personal)
   - `CLAUDE.md` (committed, shared)
   - `AGENTS.md`
   - `AI.local.md`
   - `AI.md`
   - `INSTRUCTIONS.md`

2. **Global files** (lower priority):
   - `~/.bike4mind/AI.local.md`
   - `~/.bike4mind/AI.md`

The first matching file from each layer is loaded.

---

## Tool Permissions

### Permission System

Control which tools can execute automatically:

```
First time tool runs:
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ ⚠️ Permission Required                      ┃
┃                                            ┃
┃ Tool: bash_execute                         ┃
┃                                            ┃
┃ Arguments:                                 ┃
┃   { "command": "npm install react" }       ┃
┃                                            ┃
┃ ❯ ✓ Allow once                             ┃
┃   ✓ Always allow (trust this tool)         ┃
┃   ✗ Deny                                   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Options:
  Allow once       - Permit this execution only
  Always allow     - Trust this tool (won't ask again)
  Deny             - Block this execution
```

### Trusted Tools

Manage automatic execution:

```bash
# View trusted tools
/trusted

Trusted Tools:
  ✓ bash_execute
  ✓ web_search
  ✓ weather_info

# Trust a tool
/trust math_evaluate
✓ Tool trusted: math_evaluate

# Untrust a tool
/untrust bash_execute
✓ Tool untrusted: bash_execute
```

### Security Considerations

**Low risk (safe to trust):**
- `dice_roll` - Random numbers only
- `math_evaluate` - Sandboxed calculations
- `current_datetime` - Read-only time info
- `file_read` - Read-only file access
- `glob_files` - Read-only file searching
- `grep_search` - Read-only content searching

**Medium risk (review first):**
- `web_search` - Makes external HTTP requests
- `weather_info` - Calls external API
- `create_file` - Creates new files
- `edit_local_file` - Modifies existing files

**High risk (review each time):**
- `bash_execute` - Can run any shell command
- `delete_file` - Permanently deletes files
- MCP tools with write access
- Tools from unknown sources

---

## Debug Logging

### Automatic Logs

Every session automatically logs to `~/.bike4mind/debug/[session-id].txt`.

**What's logged:**
- Session start/end
- HTTP requests/responses
- SSE streaming events
- Tool executions with parameters
- Errors and stack traces
- Authentication events

**Example log:**

```
[2025-01-14 10:30:00] SESSION_START
  Model: claude-3-opus
  API: https://app.bike4mind.com/api
  User: john@example.com

[2025-01-14 10:30:15] HTTP_REQUEST
  POST /v1/chat/completions
  Size: 2.4 KB
  Headers: [...]

[2025-01-14 10:30:16] SSE_EVENT
  type: content_block_start
  model: claude-3-opus

[2025-01-14 10:30:18] TOOL_CALL
  tool: bash_execute
  args: {"command": "ls -la"}
  result: [success] 42 files

[2025-01-14 10:35:00] SESSION_END
  Duration: 5m 0s
  Messages: 12
  Tokens: 8,432
```

### Verbose Mode

Show logs in console during session:

```bash
b4m --verbose

[DEBUG] Loading config from ~/.bike4mind/config.json
[DEBUG] Auth token valid (expires in 89 days)
[DEBUG] Connecting to https://app.bike4mind.com/api
[DEBUG] HTTP POST /v1/chat/completions
[DEBUG] SSE: content_block_start
[DEBUG] SSE: content_block_delta (42 bytes)
[DEBUG] Tool call: bash_execute
[DEBUG] Tool result: success (1.2s)
```

### View Logs

```bash
# List all logs
ls -lh ~/.bike4mind/debug/

# View latest log
tail -100 ~/.bike4mind/debug/*.txt

# Follow logs in real-time
tail -f ~/.bike4mind/debug/[session-id].txt

# Search logs for errors
grep ERROR ~/.bike4mind/debug/*.txt
```

### Log Retention

- Logs older than **30 days** are auto-deleted on CLI startup
- Manual cleanup anytime: `rm ~/.bike4mind/debug/*.txt`

---

## Interactive UI

### Status Bar

Shows session info at top of terminal:

```
┌─────────────────────────────────────────────────────────┐
│ 🤖 B4M CLI v0.2.10  |  john@example.com  |  12 messages │
└─────────────────────────────────────────────────────────┘
```

**Information displayed:**
- CLI version
- Current user
- Message count
- Token usage (if available)

### Message Display

**User messages:**
```
> Your message here
```

**Agent messages:**
```
Agent response text with formatting:
- Bullet points
- **Bold text**
- `Code snippets`
```

**Tool calls:**
```
[tool: bash_execute]
Running command: ls -la

[tool output displayed]
```

**Thinking process:**
```
💭 Thinking...
Step 1: Analysis
Step 2: Planning
Step 3: Execution
```

### Rich Formatting

Supports GitHub-flavored Markdown:

```bash
> Explain Promise.all with an example

**Promise.all** runs multiple promises concurrently:

\`\`\`typescript
const results = await Promise.all([
  fetch('/api/users'),
  fetch('/api/posts'),
  fetch('/api/comments')
]);
\`\`\`

Key points:
- Fails fast if any promise rejects
- Returns array of results
- Order matches input order
```

### Image Rendering

Images are rendered in terminals that support it:

```bash
> Show me the project logo

[Renders image inline in terminal]

# Or provides path if rendering not supported
Image saved to: ~/.bike4mind/images/logo-abc123.png
```

---

## See Also

- [Getting Started →](/cli/getting-started) - Initial setup
- [Configuration →](/cli/configuration) - Customize settings
- [Self-hosted Ollama →](/cli/local-models) - Connect to a self-hosted Ollama endpoint
- [MCP Integration →](/cli/mcp-integration) - Add more tools
- [Examples →](/cli/examples) - Real-world use cases
