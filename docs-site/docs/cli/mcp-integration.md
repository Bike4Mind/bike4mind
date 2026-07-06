---
title: MCP Integration
description: Extend B4M CLI with Model Context Protocol servers
sidebar_position: 5
---

# MCP Integration

Extend B4M CLI's capabilities by integrating Model Context Protocol (MCP) servers.

## What is MCP?

**Model Context Protocol (MCP)** is an open standard that lets AI applications access external data sources and tools. Think of it as a plugin system for AI agents.

**Use cases:**
- Access GitHub repositories, issues, and PRs
- Query databases and APIs
- Integrate with third-party services
- Add custom tools and capabilities

**Official MCP Specification:** https://modelcontextprotocol.io/

---

## 🚀 Quick Setup Guides

### GitHub Integration

**Most developers want this!** Complete guide to integrating GitHub with B4M CLI:

**[→ GitHub MCP Setup Guide](/cli/github-mcp-setup)**

Learn how to:
- Generate GitHub tokens
- Configure GitHub MCP
- Manage issues, PRs, and repositories
- Use GitHub Projects v2
- Troubleshoot common issues

**Quick setup:**
```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ]
    }
  }
}
```

---

## Built-in MCP Servers

B4M CLI includes these MCP servers in the monorepo:

### 🔧 GitHub
Manage repositories, issues, pull requests, and more.

**Configuration:**
```json
{
  "mcpServers": [
    {
      "name": "github",
      "enabled": true,
      "env": {
        "GITHUB_ACCESS_TOKEN": "ghp_your_token_here"
      }
    }
  ]
}
```

**Get a GitHub token:**
1. Visit https://github.com/settings/tokens
2. Generate new token (fine-grained recommended)
3. Grant permissions: `repo`, `read:org`, `read:user`

**Available tools:**
- List/create/update repositories
- Manage issues and PRs
- Search code
- And more...

---

### 🔧 LinkedIn
Manage LinkedIn posts and analytics.

**Configuration:**
```json
{
  "mcpServers": [
    {
      "name": "linkedin",
      "enabled": true,
      "env": {
        "LINKEDIN_ACCESS_TOKEN": "your_token",
        "COMPANY_NAME": "Your Company"
      }
    }
  ]
}
```

**Available tools:**
- Create/delete posts
- Get post analytics
- Manage company pages

---

### 🔧 Atlassian
Integrate with Jira and Confluence.

**Configuration:**
```json
{
  "mcpServers": [
    {
      "name": "atlassian",
      "enabled": true,
      "env": {
        "ATLASSIAN_ACCESS_TOKEN": "your_token",
        "ATLASSIAN_CLOUD_ID": "your_cloud_id",
        "ATLASSIAN_SITE_URL": "https://yoursite.atlassian.net"
      }
    }
  ]
}
```

**Available tools:**
- Create/update Jira issues
- Search Jira
- Create/update Confluence pages

---

## Configuration Hierarchy

B4M CLI loads MCP server configurations from multiple sources with the following priority (lowest to highest):

1. **`.mcp.json`** (project root) - Shared across all development tools
2. **`~/.bike4mind/config.json`** (user's home) - User-specific global settings
3. **`.bike4mind/config.json`** (project root) - Team-shared B4M-specific settings
4. **`.bike4mind/local.json`** (project root) - Developer-specific overrides

**Example hierarchy:**

```plaintext
.mcp.json                    # ← Lowest priority (portable format)
  github, context7

~/.bike4mind/config.json     # ← User global config
  github (disabled),         # Overrides .mcp.json
  postgres

.bike4mind/config.json       # ← Project team config
  github (enabled),          # Overrides user config
  custom-api

.bike4mind/local.json        # ← Highest priority (developer-specific)
  context7 (disabled)        # Overrides all previous configs
```

**Result:** `github` (enabled), `postgres`, `custom-api`, `context7` (disabled)

:::tip
Use `.mcp.json` for configurations that should work across different tools (Claude Code, B4M CLI, etc.). Use B4M-specific configs for tool-specific settings or overrides.
:::

---

## Configuration Methods

### Method 1: Internal Servers (Auto-Discovery)

For MCP servers bundled with the monorepo, omit `command` and `args`—the CLI auto-discovers them:

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

**How it works:**
- CLI looks in `b4m-core/mcp/dist/src/[name]/server.js`
- Runs the server using Node.js
- Communicates via stdio

**Requirements:**
- MCP packages must be built: `pnpm core:build`
- Only works when running from monorepo or with locally installed MCP packages

---

### Method 2: Docker Containers

Run MCP servers in Docker for isolation and portability:

```json
{
  "mcpServers": [
    {
      "name": "github",
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e", "GITHUB_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      },
      "enabled": true
    }
  ]
}
```

**Docker flags:**
- `-i`: Interactive (required for stdio communication)
- `--rm`: Auto-remove container after exit
- `-e VAR`: Pass environment variable from host

**Requirements:**
- Docker installed and running
- Image must be pulled or built: `docker pull ghcr.io/github/github-mcp-server`

---

### Method 3: NPX or Custom Commands

Run any MCP server via npx or custom executables:

```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/allowed/dir"
      ],
      "env": {},
      "enabled": true
    }
  ]
}
```

**Use cases:**
- Public MCP packages from npm
- Custom MCP servers you've built
- Third-party integrations

---

## Managing MCP Servers

B4M CLI provides commands to manage MCP servers both inside and outside the interactive session.

### Inside CLI: View Status

Use `/mcp` command inside the interactive session to view configured and connected MCP servers:

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

This shows:
- **Configured servers**: All servers defined in your config
- **Status**: Whether each server is enabled or disabled
- **Connected & Active**: Servers that successfully connected at startup
- **Tool count**: Number of tools available from each connected server

### Outside CLI: Manage Servers

Use `b4m mcp` commands to add, remove, enable, or disable MCP servers:

#### List Servers

```bash
b4m mcp list
```

Shows all configured MCP servers and their status.

#### Add Server

```bash
b4m mcp add <name> -- <command> [args...]
```

**Important:** The `--` separator is required to separate the server name from the command.

**Examples:**

```bash
# Add Context7 MCP server
b4m mcp add context7 -- npx -y @upstash/context7-mcp

# Add GitHub MCP server via Docker
b4m mcp add github -- docker run -i ghcr.io/modelcontextprotocol/servers/github

# Add filesystem MCP server with allowed directory
b4m mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /allowed/path
```

The server is added to `~/.bike4mind/config.json` and will be available the next time you start the CLI.

#### Remove Server

```bash
b4m mcp remove <name>
```

**Example:**

```bash
b4m mcp remove context7
```

#### Enable/Disable Server

```bash
# Enable a server
b4m mcp enable <name>

# Disable a server
b4m mcp disable <name>
```

**Example:**

```bash
# Temporarily disable GitHub server
b4m mcp disable github

# Re-enable it later
b4m mcp enable github
```

**Note:** Changes to MCP servers require restarting the CLI to take effect.

---

## Configuration Reference

### Configuration Formats

B4M CLI supports **two interchangeable formats** for MCP server configuration:

#### Format 1: Object Format (Portable)

This format is used by `.mcp.json` files and is compatible with Claude Code and other development tools. Server names are keys in an object:

```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": {},
      "enabled": true
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "env": {},
      "enabled": true
    }
  }
}
```

**Benefits:**
- ✅ Portable across development tools (Claude Code, B4M CLI, etc.)
- ✅ Easy to read and edit
- ✅ Natural de-duplication by server name

#### Format 2: Array Format (B4M Native)

This format uses an array with explicit `name` fields:

```json
{
  "mcpServers": [
    {
      "name": "github",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": {},
      "enabled": true
    },
    {
      "name": "context7",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "env": {},
      "enabled": true
    }
  ]
}
```

**Both formats are fully supported** in all B4M configuration files:
- `.mcp.json` (project-level)
- `.bike4mind/config.json` (project team-shared)
- `.bike4mind/local.json` (developer-specific)
- `~/.bike4mind/config.json` (global user config)

:::tip
Use **object format** for better compatibility with other tools. Use **array format** if you prefer explicit ordering.
:::

### Field Definitions

**Object format:**
```typescript
{
  "serverName": {
    "command": string?,     // Executable (omit for internal servers)
    "args": string[]?,      // Command arguments
    "env": {                // Environment variables
      [key: string]: string
    },
    "enabled": boolean?     // Default: true
  }
}
```

**Array format:**
```typescript
{
  "name": string,         // Unique identifier for the server
  "command": string?,     // Executable (omit for internal servers)
  "args": string[]?,      // Command arguments
  "env": {                // Environment variables
    [key: string]: string
  },
  "enabled": boolean?     // Default: true
}
```

### Example: `.mcp.json` (Project-Level Config)

Create a `.mcp.json` file in your project root for team-shared MCP configuration:

```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ]
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
```

:::info
`.mcp.json` files use the **object format** for portability across tools. The `enabled` field defaults to `true` if omitted.
:::

### Example: Full Configuration (Array Format)

```json
{
  "mcpServers": [
    {
      "name": "github",
      "enabled": true,
      "env": {
        "GITHUB_ACCESS_TOKEN": "ghp_abc123"
      }
    },
    {
      "name": "custom-api",
      "command": "node",
      "args": ["/path/to/mcp-server.js"],
      "env": {
        "API_KEY": "xyz789"
      },
      "enabled": true
    },
    {
      "name": "disabled-server",
      "enabled": false,
      "env": {}
    }
  ]
}
```

---

## Using MCP Tools

Once configured, MCP tools are available automatically in conversations.

### Discovery

The agent can see all available MCP tools:

```bash
> What MCP tools are available?

I have access to these MCP tools:

**GitHub:**
- github__list_repos
- github__create_issue
- github__list_issues
- github__get_pull_request
... (and more)
```

### Execution

Tools are called automatically when relevant:

```bash
> List my GitHub repositories

[mcp:github__list_repos]

Here are your repositories:
1. myuser/project-a (TypeScript)
2. myuser/project-b (Python)
3. myuser/docs (Markdown)
```

### Permission Control

MCP tools follow the same permission system as built-in tools.

**First use prompts for permission:**

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ ⚠️ Permission Required                      ┃
┃                                            ┃
┃ Tool: github__create_issue                 ┃
┃                                            ┃
┃ Arguments:                                 ┃
┃   {                                        ┃
┃     "repository": "myuser/project-a",      ┃
┃     "title": "Fix login bug"               ┃
┃   }                                        ┃
┃                                            ┃
┃ ❯ ✓ Allow once                             ┃
┃   ✓ Always allow (trust this tool)         ┃
┃   ✗ Deny                                   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

**Manage permissions:**

```bash
# Trust an MCP tool
/trust github__create_issue

# Untrust an MCP tool
/untrust github__create_issue

# List trusted tools (includes MCP)
/trusted
```

---

## Building Custom MCP Servers

### Server Structure

```javascript
// my-mcp-server.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({
  name: 'my-custom-server',
  version: '1.0.0',
});

// Register tools
server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'my_tool',
      description: 'Does something useful',
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string' }
        },
        required: ['input']
      }
    }
  ]
}));

// Handle tool calls
server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name === 'my_tool') {
    return {
      content: [
        {
          type: 'text',
          text: `Processed: ${request.params.arguments.input}`
        }
      ]
    };
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Add to B4M CLI

```json
{
  "mcpServers": [
    {
      "name": "my-server",
      "command": "node",
      "args": ["/path/to/my-mcp-server.js"],
      "env": {
        "API_KEY": "..."
      },
      "enabled": true
    }
  ]
}
```

**Learn more:** [MCP Specification](https://modelcontextprotocol.io/)

---

## Community MCP Servers

Explore public MCP servers:

### Official Servers

- **@modelcontextprotocol/server-filesystem** - File operations
- **@modelcontextprotocol/server-github** - GitHub integration
- **@modelcontextprotocol/server-postgres** - PostgreSQL queries

### Third-Party Servers

Search npm for MCP servers:
```bash
npm search mcp-server
```

**Install and use:**
```json
{
  "mcpServers": [
    {
      "name": "community-server",
      "command": "npx",
      "args": ["-y", "@someone/mcp-server-name"],
      "enabled": true
    }
  ]
}
```

---

## Troubleshooting MCP

### Server Won't Start

**Check if Docker is running (for Docker servers):**
```bash
docker ps
```

**Check if internal server is built:**
```bash
ls b4m-core/mcp/dist/src/github/server.js
```

If missing, build it:
```bash
pnpm core:build
```

### Tool Not Found

**Verify server is enabled:**
```json
{
  "enabled": true  // Make sure this is true
}
```

**Check debug logs:**
```bash
b4m --verbose
# Or view logs
tail -f ~/.bike4mind/debug/*.txt
```

### Permission Denied

**Check environment variables are set:**
```json
{
  "env": {
    "GITHUB_ACCESS_TOKEN": "ghp_..."  // Must not be empty
  }
}
```

**Verify token permissions:**
- GitHub: Needs `repo`, `read:org` scopes
- LinkedIn: Needs `w_member_social` scope
- Atlassian: Needs `read:jira-work`, `write:jira-work`

### Server Crashes

**Check command is correct:**
```json
{
  "command": "node",  // Must be in PATH
  "args": ["/full/path/to/server.js"]  // Use absolute path
}
```

**View stderr output:**
```bash
b4m --verbose
# Server errors appear in console
```

---

## Advanced MCP Configuration

### Multiple Instances

Run the same server multiple times with different configs:

```json
{
  "mcpServers": [
    {
      "name": "github-personal",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_TOKEN", "mcp-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_personal_token"
      },
      "enabled": true
    },
    {
      "name": "github-work",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_TOKEN", "mcp-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_work_token"
      },
      "enabled": true
    }
  ]
}
```

### Conditional Servers

Enable servers per-project using context files:

**~/.bike4mind/config.json** (default: disabled)
```json
{
  "mcpServers": [
    {
      "name": "github",
      "enabled": false,
      "env": { "GITHUB_ACCESS_TOKEN": "..." }
    }
  ]
}
```

**project/CLAUDE.md**
```markdown
Enable GitHub MCP server for this project.
```

Then manually enable when needed:
```bash
# Edit config to set enabled: true for this session
```

_(Full conditional config coming in future version)_

---

## See Also

- **[GitHub MCP Setup →](/cli/github-mcp-setup)** - Dedicated GitHub integration guide
- [Configuration →](/cli/configuration) - General CLI configuration
- [Commands Reference →](/cli/commands) - Tool permission commands
- [MCP Specification](https://modelcontextprotocol.io/) - Official MCP docs
- [Troubleshooting →](/cli/troubleshooting) - Common MCP issues
