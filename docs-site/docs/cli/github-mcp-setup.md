---
title: GitHub MCP Setup
description: Complete guide to integrating GitHub with B4M CLI using MCP
sidebar_position: 6
---

# GitHub MCP Setup Guide

Integrate GitHub with B4M CLI to manage repositories, issues, pull requests, and more directly from your terminal.

## Overview

The GitHub MCP (Model Context Protocol) integration provides:

- 📦 **Repository Management** - List, create, and manage repositories
- 🐛 **Issue Tracking** - Create, update, list, and search issues
- 🔀 **Pull Requests** - View PRs, check status, and review changes
- 🔍 **Code Search** - Search across repositories
- 🌿 **Branch Operations** - List and manage branches
- 📝 **Commit History** - View commit logs and details
- 📊 **GitHub Projects** - Manage GitHub Projects v2 fields

**All GitHub tools are automatically namespaced** as `github__*` to avoid conflicts with other MCP servers.

---

## Quick Start

### Step 1: Get a GitHub Token

Generate a **Personal Access Token (fine-grained)** at:
https://github.com/settings/personal-access-tokens/new

**Required Permissions:**
- **Repository access**: Select repositories you want to access
- **Permissions**:
  - Contents: Read and write
  - Issues: Read and write
  - Pull requests: Read and write
  - Metadata: Read-only (automatically included)

:::tip
Fine-grained tokens are more secure than classic tokens because you can scope them to specific repositories and permissions.
:::

### Step 2: Configure GitHub MCP

Add GitHub MCP to your `.mcp.json` (project root):

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
    }
  }
}
```

### Step 3: Set Environment Variable

Add your token to your shell environment:

**macOS/Linux (.bashrc, .zshrc, etc.):**
```bash
export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_your_token_here"
```

**Or create `.env.secrets` in project root:**
```bash
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_token_here
```

:::warning
Never commit your token to git! Add `.env.secrets` to `.gitignore`.
:::

### Step 4: Verify Setup

```bash
b4m mcp list
```

You should see:
```
📁 Project MCP config loaded from: /path/to/project/.mcp.json
📡 Configured MCP Servers:

• github - ✅ Enabled
  Command: docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
  Env vars: GITHUB_PERSONAL_ACCESS_TOKEN
```

---

## Configuration Options

### Option 1: Docker (Recommended)

Uses the official GitHub MCP Docker image. Requires Docker installed and running.

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
    }
  }
}
```

**Pros:**
- ✅ Isolated environment
- ✅ Official image maintained by GitHub
- ✅ No local dependencies

**Cons:**
- ❌ Requires Docker running
- ❌ Slightly slower startup

### Option 2: NPM Package

Install and run via npx:

```bash
npm install -g @modelcontextprotocol/server-github
```

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

**Pros:**
- ✅ Faster startup
- ✅ No Docker required

**Cons:**
- ❌ Requires Node.js installed
- ❌ Token in config file (less secure)

:::tip
Use Docker for better security (env vars) and isolation. Use NPM for faster startup if you trust your environment.
:::

### Option 3: Multiple GitHub Accounts

Configure separate instances for personal and work accounts:

```json
{
  "mcpServers": {
    "github-personal": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_personal_token"
      }
    },
    "github-work": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_work_token"
      }
    }
  }
}
```

Tools will be namespaced as:
- `github-personal__create_issue`
- `github-work__create_issue`

---

## Available Tools

All GitHub MCP tools are namespaced with `github__` prefix.

### Issue Management

- `github__create_issue` - Create new issues
- `github__get_issue` - Get issue details
- `github__list_issues` - List issues with filters
- `github__update_issue` - Update issue properties
- `github__search_code` - Search code across repos

### Repository Operations

- `github__list_repositories` - List accessible repositories
- `github__get_repository` - Get repository details
- `github__list_branches` - List repository branches

### Pull Requests

- `github__list_pull_requests` - List PRs
- `github__get_pull_request` - Get PR details

### Commits

- `github__list_commits` - View commit history
- `github__get_commit` - Get commit details

### GitHub Projects v2

- `github__list_org_projects` - List organization projects
- `github__list_project_fields` - List project fields
- `github__get_project_item` - Get issue as project item
- `github__add_issue_to_project` - Add issue to project
- `github__update_project_item_fields` - Update project fields
- `github__list_org_issue_types` - List issue types

:::info
The AI automatically uses these tools when you ask about GitHub operations. You don't need to call them explicitly.
:::

---

## Usage Examples

### Create an Issue

```bash
> Create an issue in myorg/myrepo titled "Fix login bug" with description "Users can't log in with SSO"
```

The AI will:
1. Call `github__create_issue`
2. Show you the created issue number and URL
3. Return confirmation

### List Recent Issues

```bash
> Show me the last 10 open issues in myorg/myrepo
```

The AI will:
1. Call `github__list_issues` with filters
2. Display formatted list with issue numbers, titles, and states

### Search Code

```bash
> Find all files that import React in myorg/myrepo
```

The AI will:
1. Call `github__search_code` with query
2. Show matching files with line numbers
3. Provide code snippets

### Update Project Fields

```bash
> Set the priority of issue #123 in myorg/myrepo to P1
```

The AI will:
1. Call `github__get_issue` to get issue details
2. Call `github__get_project_item` to get project item ID
3. Call `github__list_project_fields` to get field IDs
4. Call `github__update_project_item_fields` to set priority
5. Show confirmation

### Check PR Status

```bash
> What's the status of PR #456 in myorg/myrepo?
```

The AI will:
1. Call `github__get_pull_request`
2. Show PR state, reviews, checks, and merge status

---

## Troubleshooting

### Issue: "Permission denied" or 401 errors

**Cause:** Token doesn't have required permissions or has expired.

**Solution:**
1. Go to https://github.com/settings/personal-access-tokens
2. Find your token and check expiration
3. Verify permissions: Contents (read/write), Issues (read/write), Pull requests (read/write)
4. Regenerate token if expired
5. Update environment variable

### Issue: GitHub MCP server won't start

**Cause:** Docker not running or image not pulled.

**Solution:**
```bash
# Check if Docker is running
docker ps

# Pull the GitHub MCP image
docker pull ghcr.io/github/github-mcp-server

# Test the server manually
docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
```

### Issue: "Repository not found"

**Cause:** Token doesn't have access to the repository.

**Solution:**
1. For fine-grained tokens: Edit token and add repository to access list
2. For classic tokens: Verify `repo` scope is enabled
3. Check repository ownership/permissions in GitHub

### Issue: Tools not appearing

**Cause:** Server failed to connect during startup.

**Solution:**
```bash
# Check server status
b4m mcp list

# View logs
b4m --verbose

# Restart CLI
exit
b4m
```

### Issue: Environment variable not found

**Cause:** `GITHUB_PERSONAL_ACCESS_TOKEN` not set in environment.

**Solution:**

**Verify it's set:**
```bash
echo $GITHUB_PERSONAL_ACCESS_TOKEN
```

**If empty, add to shell config:**
```bash
# For bash
echo 'export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_your_token"' >> ~/.bashrc
source ~/.bashrc

# For zsh
echo 'export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_your_token"' >> ~/.zshrc
source ~/.zshrc
```

### Issue: Duplicate tool names error

**Cause:** Multiple MCP servers with same tool names (should be fixed in latest version).

**Solution:**
Update to latest B4M CLI version which namespaces all MCP tools:
```bash
pnpm install -g @bike4mind/cli@latest
```

---

## Security Best Practices

### ✅ Do:

- Use **fine-grained tokens** with minimal permissions
- Set token expiration (90 days recommended)
- Store tokens in environment variables, not config files
- Add `.env.secrets` to `.gitignore`
- Use Docker for token isolation
- Rotate tokens regularly
- Use different tokens for personal/work

### ❌ Don't:

- Commit tokens to git repositories
- Use classic tokens with full repo access
- Share tokens between projects
- Store tokens in `.mcp.json` (use env vars)
- Give tokens unlimited expiration
- Use tokens for CI/CD (use GitHub Apps instead)

---

## Advanced Configuration

### Filtering Repositories

Limit GitHub MCP to specific repositories using `SELECTED_REPOSITORIES`:

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
        "-e",
        "SELECTED_REPOSITORIES",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "SELECTED_REPOSITORIES": "myorg/repo1,myorg/repo2"
      }
    }
  }
}
```

This improves performance and security by limiting scope.

### Team Configuration

For team projects, commit `.mcp.json` with Docker setup:

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
    }
  }
}
```

Each developer sets their own token:
```bash
export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_individual_token"
```

### Conditional Enabling

Enable GitHub MCP only in specific projects using configuration hierarchy:

**~/.bike4mind/config.json** (global - disabled by default):
```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "enabled": false
    }
  }
}
```

**project/.bike4mind/local.json** (enable for this project):
```json
{
  "mcpServers": {
    "github": {
      "enabled": true
    }
  }
}
```

---

## Performance Tips

### 1. Use Repository Filtering

Limit to repositories you actually need:
```bash
export SELECTED_REPOSITORIES="myorg/repo1,myorg/repo2"
```

### 2. Cache Token in Environment

Don't regenerate tokens frequently - they work until expiration.

### 3. Use Docker Image Caching

Pull the image once:
```bash
docker pull ghcr.io/github/github-mcp-server
```

Docker will use cached image on subsequent runs.

### 4. Minimize Unnecessary Calls

Be specific in your requests:
- ✅ "List open issues in myorg/myrepo"
- ❌ "Show me all issues everywhere" (slow)

---

## Migration from GitHub CLI

If you're familiar with `gh` CLI, here's how B4M CLI compares:

| GitHub CLI (`gh`) | B4M CLI with GitHub MCP |
|-------------------|-------------------------|
| `gh issue create` | Ask: "Create an issue in owner/repo" |
| `gh issue list` | Ask: "List issues in owner/repo" |
| `gh pr view 123` | Ask: "Show me PR #123 in owner/repo" |
| `gh repo list` | Ask: "What repositories do I have access to?" |
| `gh search code` | Ask: "Search for 'query' in owner/repo" |

**Benefits of B4M CLI:**
- Natural language interface
- Context-aware suggestions
- Combines multiple operations automatically
- Works alongside other MCP servers

---

## Related Documentation

- [MCP Integration Overview →](/cli/mcp-integration) - General MCP concepts
- [Configuration →](/cli/configuration) - B4M CLI configuration
- [Troubleshooting →](/cli/troubleshooting) - Common issues
- [GitHub MCP Official Docs](https://github.com/github/github-mcp-server) - Upstream documentation

---

## Frequently Asked Questions

### Can I use GitHub Enterprise?

Yes! Set the `GITHUB_ENTERPRISE_HOST` environment variable:

```bash
export GITHUB_ENTERPRISE_HOST="github.company.com"
export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_enterprise_token"
```

### Does this work with GitHub Actions?

The GitHub MCP server is for interactive use. For CI/CD, use GitHub Actions with standard authentication methods.

### Can I manage private repositories?

Yes, as long as your token has access to them. Fine-grained tokens require explicit repository selection.

### How many API calls does this use?

Each tool call typically uses 1-3 GitHub API calls. The AI is smart about batching operations and caching results.

### Can I use this offline?

No, GitHub MCP requires internet access to communicate with GitHub's API.

### Does this support GitHub Copilot?

These are separate features. GitHub MCP provides CLI integration, while GitHub Copilot is an IDE extension.

---

## Next Steps

1. ✅ Set up your GitHub token
2. ✅ Configure `.mcp.json`
3. ✅ Try creating an issue
4. ✅ Explore other tools
5. ✅ Share configuration with your team

**Need help?** Join our [GitHub Discussions](https://github.com/bike4mind/bike4mind/discussions) or [open an issue](https://github.com/bike4mind/bike4mind/issues).
