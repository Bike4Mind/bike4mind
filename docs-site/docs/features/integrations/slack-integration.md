---
title: Slack Integration
description: Use AI agents in Slack with @mentions, thread intelligence, and natural language commands for GitHub, Jira, and Confluence
sidebar_position: 1
tags: [slack, integration, agents, ai]
---

# Slack Integration

Bring Bike4Mind's AI agents directly into your Slack workspace. @mention agents to ask questions, create issues, manage projects, and automate workflows — all without leaving Slack.

## Overview

The Slack integration provides:

- **AI agents in channels** — @mention specialized agents for different tasks
- **Thread intelligence** — agents understand conversation context and extract decisions
- **Slash commands** — quick actions with `/b4m` and `/notebook`
- **Cross-integration actions** — create GitHub issues, Jira tickets, and Confluence pages from Slack
- **Model configuration** — admins can set different AI models per channel or agent

## Available Agents

| Agent | Use For | Example |
|---|---|---|
| `@agent` | General questions, help, explanations | `@agent explain REST APIs` |
| `@dev` | GitHub issues, technical tasks, code questions | `@dev create issue about the login bug` |
| `@pm` | Jira tickets, project planning, epics | `@pm create epic from this conversation` |
| `@analyst` | Data analysis, metrics, insights | `@analyst summarize our sprint metrics` |
| `@researcher` | Documentation, search, knowledge management | `@researcher find our API docs on auth` |

:::tip Getting Help
Type `@agent help` in any channel to see all available commands and agents.
:::

## Getting Started

### Prerequisites

- A Bike4Mind account with organization membership
- A Slack workspace with the Bike4Mind bot installed (see [Admin Guide](./slack-admin-guide.md))
- Optional: GitHub and/or Atlassian accounts connected in Bike4Mind (for cross-integration features)

### Step 1: Link Your Slack Account

1. Go to **Profile → Integrations** in Bike4Mind
2. Find **Slack Integration**
3. Copy your Slack Member ID:
   - In Slack: Click your profile → **Profile** → **More (...)** → **Copy member ID**
4. Paste into Bike4Mind and click **Save**

### Step 2: Start Using Agents

In any Slack channel where the Bike4Mind bot is present:

```
@agent What's the status of our deployment pipeline?
```

```
@dev Create an issue for the timeout bug in the login flow
```

```
@pm Create a Jira ticket for the feature request we just discussed
```

## Key Features

### Thread Intelligence

When you @mention an agent in a thread, it reads the entire thread context to provide informed responses:

- **Decision extraction** — identifies decisions made in the conversation
- **Action item detection** — spots tasks and follow-ups
- **Context-aware creation** — creates issues/tickets with full conversation context

### Cross-Integration Actions

From Slack, agents can interact with your connected services:

| Action | Agent | Requires |
|---|---|---|
| Create GitHub issue | `@dev` | GitHub connected |
| Create Jira ticket | `@pm` | Atlassian connected |
| Create Confluence page | `@researcher` | Atlassian connected |
| Search code | `@dev` | GitHub connected |
| Search Jira issues | `@pm` | Atlassian connected |

### Push Notifications

Receive GitHub event notifications directly in Slack DMs. See [GitHub Slack Notifications](../github-slack-notifications.md) for setup.

## Permissions and Scopes

The Slack bot requires these permissions to function:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Detect @mentions of agents |
| `channels:history` | Read channel messages for context |
| `channels:read` | List channels the bot can access |
| `chat:write` | Send responses and notifications |
| `commands` | Register slash commands |
| `files:read` | Access shared files for analysis |
| `groups:history` | Read private channel messages |
| `groups:read` | List private channels |
| `im:history` | Read DM messages |
| `im:read` | List DM conversations |
| `im:write` | Send DMs (notifications) |
| `users:read` | Look up user information |
| `users:read.email` | Match Slack users to Bike4Mind accounts |

## Rate Limits

Slack enforces rate limits that affect the integration:

| API Method | Limit | Notes |
|---|---|---|
| `chat.postMessage` | 1 message/second per channel | Responses may queue during high activity |
| `conversations.history` | 50 requests/minute | Thread context reads |
| Web API (general) | Varies by method | See [Slack rate limits](https://api.slack.com/docs/rate-limits) |

:::info Slack Rate Limit Behavior
When rate limited, Slack returns a `429` status with a `Retry-After` header. Bike4Mind automatically retries after the specified delay. You may notice brief delays in agent responses during peak usage.
:::

## Known Limitations

- **Bot must be in channel** — agents can only respond in channels where the bot has been invited (`/invite @Bike4Mind Bot`)
- **Thread depth** — very long threads may be truncated when reading context
- **File size** — files shared in Slack must be under 20 MB for analysis
- **Private channels** — the bot must be explicitly invited to private channels
- **DMs** — agents respond to DMs but with limited cross-integration capabilities (no thread context from channels)

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| Bot doesn't respond | Bot not in channel | `/invite @Bike4Mind Bot` in the channel |
| "Not connected" | Slack account not linked | Link in Profile → Integrations |
| "GitHub not connected" | GitHub needed but not linked | Connect GitHub in Profile → Integrations |
| "Atlassian not connected" | Atlassian needed but not linked | Connect Atlassian in Profile → Integrations |

## Troubleshooting

For common issues, see the [Troubleshooting Guide](./troubleshooting.md#slack).

**Quick fixes:**

- **Bot doesn't respond** → Ensure the bot is invited to the channel
- **"Permission denied"** → Check that the bot has the required scopes
- **Slow responses** → May be rate limited; wait a moment and retry

## Related Documentation

- [Slack Admin Guide](./slack-admin-guide.md) — App setup and workspace management
- [Slack Commands Reference](./slack-commands.md) — All slash commands and @mention patterns
- [Organization Slack Integration](../org-slack-self-service.md) — Self-service workspace connection
- [Slack Multi-Workspace OAuth](../slack-multi-workspace-oauth.md) — Multi-workspace setup
- [Slack Model Configuration](../slack-model-config.md) — Configure AI models per channel
- [GitHub Slack Notifications](../github-slack-notifications.md) — GitHub events in Slack DMs
