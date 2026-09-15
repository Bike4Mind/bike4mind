---
title: GitHub Integration
description: Connect GitHub to Bike4Mind for AI-powered repository management, issue tracking, and code search
sidebar_position: 1
tags: [github, integration, oauth, mcp]
---

# GitHub Integration

Connect your GitHub account to Bike4Mind and let AI agents manage issues, review pull requests, search code, and monitor CI/CD workflows — all through natural conversation.

## Overview

With the GitHub integration, you can:

- **Search code** across repositories using GitHub query syntax
- **Manage issues** — create, update, comment, and track issues with labels and milestones
- **Work with pull requests** — create, review, approve, request changes, and merge PRs
- **Browse repositories** — list repos, branches, commits, and file contents
- **Manage projects** — add issues to GitHub Projects v2, update field values
- **Monitor CI/CD** — view workflow runs, check job logs, diagnose failures
- **Organize work** — create labels, milestones, and issue types

## Getting Started

### Step 1: Connect Your GitHub Account

1. Navigate to **Profile → Integrations** in Bike4Mind
2. Click **Connect GitHub**
3. You'll be redirected to GitHub to authorize access
4. Review the requested permissions and click **Authorize**
5. You'll be redirected back to Bike4Mind with your account connected

:::tip Organization Access
If you need access to organization repositories, ensure your GitHub account has the necessary org membership. You may need an org admin to approve the OAuth app.
:::

### Step 2: Start Using GitHub Tools

Once connected, AI agents can access your GitHub data. Simply ask in a conversation:

- *"Search for authentication-related code in our frontend repo"*
- *"Create an issue for the login bug we discussed"*
- *"Show me the failing CI workflow on the main branch"*
- *"List open PRs that need review"*

## Key Features

### Issue Management

| Action | What It Does | Example Prompt |
|---|---|---|
| Create issue | Opens a new issue with title, body, labels, assignees | *"Create an issue titled 'Fix login timeout' with bug label"* |
| Update issue | Modifies title, body, state, labels, assignees, type | *"Close issue #42 and add the 'resolved' label"* |
| List issues | Filters by state, labels, assignee, or type | *"Show open bugs assigned to me"* |
| Get issue details | Retrieves full issue with labels, milestone, projects | *"Get details on issue #123"* |
| Comment on issue | Adds a comment to an existing issue | *"Comment on issue #42 with our findings"* |

### Pull Request Workflows

| Action | What It Does | Example Prompt |
|---|---|---|
| List PRs | Filter by state, author, labels | *"Show open PRs in the frontend repo"* |
| Get PR details | View diffs, commits, mergeability, review comments | *"Show me the changes in PR #55"* |
| Create PR | Open a new PR with title, body, head/base branches | *"Create a draft PR from feature-branch to main"* |
| Review PR | Approve, request changes, or comment with inline notes | *"Approve PR #55 with a note about the API change"* |
| Merge PR | Merge with configurable method (merge/squash/rebase) | *"Squash merge PR #55"* |

### Code Search

Search code across all accessible repositories using GitHub's search syntax:

- *"Search for 'useAuth' in TypeScript files"*
- *"Find all API route handlers in the server package"*
- *"Search for TODO comments in the frontend repo"*

### GitHub Projects v2

| Action | What It Does |
|---|---|
| List projects | View all Projects v2 for an organization |
| List fields | See project fields (Status, Priority, Size, etc.) with available options |
| Get project item | View an issue's project field values |
| Add to project | Add an issue to a project (required before updating fields) |
| Update fields | Set Status, Priority, Size, and other fields on project items |

### CI/CD Monitoring

| Action | What It Does |
|---|---|
| List workflow runs | View recent runs filtered by branch, status, or trigger |
| Get run details | See jobs and steps with failure summaries |
| Get run logs | Download and summarize all logs, with error extraction |
| Get job logs | View logs for a specific job with optional step filtering |

## Permissions and Scopes

The GitHub OAuth integration requests the following scopes:

| Scope | Purpose |
|---|---|
| `repo` | Full access to repositories (issues, PRs, code, commits, branches) |
| `read:org` | Read organization membership and teams |
| `read:user` | Read user profile information |
| `project` | Access to GitHub Projects v2 |

:::warning Scope Requirements
All four scopes are required for full functionality. If you deny any scope, some features may not work. For example, without `project` scope, GitHub Projects v2 tools will fail.
:::

## Rate Limits

GitHub API enforces these rate limits:

| Type | Limit | Reset Period |
|---|---|---|
| Authenticated REST API | 5,000 requests/hour | Rolling 1-hour window |
| Search API | 30 requests/minute | Rolling 1-minute window |
| GraphQL API (Projects v2) | 5,000 points/hour | Rolling 1-hour window |

:::info Rate Limit Handling
When rate limits are exceeded, requests will fail with a `403` status. Bike4Mind surfaces these errors in the conversation with the reset time. Wait for the reset period or reduce request frequency.
:::

## Known Limitations

- **GitHub Enterprise Server** is not currently supported — only GitHub.com (cloud)
- **File creation** is limited to one file per commit (no multi-file commits)
- **Large diffs** may fail if the diff exceeds GitHub's size limits
- **Draft PR conversion** uses GraphQL API which has separate rate limits
- **Search** is limited to indexed code — very recent commits may not appear immediately
- **Projects v2** tools scan up to 1,000 items per project when looking up an issue

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| `401 Unauthorized` | Token expired or revoked | Reconnect GitHub in Profile → Integrations |
| `403 Forbidden` | Rate limit exceeded or insufficient scope | Wait for reset or check scope permissions |
| `404 Not Found` | Repository, issue, or PR doesn't exist or you lack access | Verify the resource exists and you have access |
| `422 Unprocessable` | Invalid input (e.g., bad label name, duplicate branch) | Check the error message for specifics |

## Troubleshooting

For common issues, see the [Troubleshooting Guide](./troubleshooting.md#github).

**Quick fixes:**

- **"Cannot access repository"** → Ensure you have read access to the repo on GitHub
- **"OAuth app not approved"** → Ask your org admin to approve the Bike4Mind OAuth app
- **"Rate limit exceeded"** → Wait for the reset time shown in the error message

## Related Documentation

- [GitHub Webhooks](./github-webhooks.md) — Set up real-time event notifications
- [GitHub MCP Tools Reference](./github-mcp-tools.md) — Complete tool documentation
- [GitHub Slack Notifications](../github-slack-notifications.md) — Get GitHub events in Slack DMs
- [External Integrations Overview](./index.md) — All integrations at a glance
