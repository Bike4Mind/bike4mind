---
title: External Integrations
description: Connect Bike4Mind to GitHub, Slack, Jira, and Confluence for AI-powered workflow automation
sidebar_position: 1
tags: [integrations, github, slack, jira, confluence, mcp]
---

# External Integrations

Bike4Mind connects to the tools your team already uses — GitHub, Slack, Jira, and Confluence — so your AI agents can read, write, and act across your entire workflow.

## Integration Matrix

| Integration | Auth Method | MCP Tools | Webhooks | Key Capabilities |
|---|---|---|---|---|
| **GitHub** | Personal OAuth + Org GitHub App/PAT | 46 tools (14 categories) | Yes (10 events) | Issues, PRs, code search, projects, CI/CD workflows |
| **Slack** | Multi-workspace OAuth | — | — | AI agents in channels, thread intelligence, slash commands |
| **Jira** | Atlassian OAuth 2.0 (shared) | 40 tools (7 categories) | Yes (11 events) | Issues, sprints, boards, JQL search, bulk operations |
| **Confluence** | Atlassian OAuth 2.0 (shared) | 23 tools (4 categories) | — | Pages, search (CQL), comments, restrictions, attachments |
| **LinkedIn** | OAuth 2.0 | 2 tools | — | Get posts, get company info (minimal) |

## Prerequisites

Before connecting any integration, ensure:

- You have an active Bike4Mind account with organization membership
- Your organization admin has enabled the integration in **Settings → Integrations**
- You have the required permissions on the external service (GitHub, Slack, Atlassian)

:::tip One-Time Atlassian OAuth
Jira and Confluence share a single Atlassian OAuth connection. Connecting once grants access to both services for your selected Atlassian site.
:::

## Security Overview

All integrations follow these security principles:

| Feature | Details |
|---|---|
| **Token storage** | Encrypted at rest using AES-256-GCM |
| **Webhook signatures** | HMAC-SHA256 with timing-safe comparison |
| **OAuth state** | CSRF-protected with signed state parameters |
| **Secret rotation** | 24-hour dual-acceptance window during rotation |
| **Payload limits** | 1 MB maximum per webhook delivery |
| **Circuit breaker** | Auto-disables subscriptions after repeated delivery failures |

## Getting Started

Choose your integration to get started:

### GitHub

Connect your GitHub repositories and let AI agents manage issues, review PRs, search code, and monitor CI/CD.

- [GitHub Integration Guide](./github-integration.md) — Setup and key features
- [GitHub Webhooks](./github-webhooks.md) — Real-time event notifications
- [GitHub MCP Tools Reference](./github-mcp-tools.md) — All 46 tools

### Slack

Bring AI agents into your Slack workspace with @mentions, slash commands, and thread-aware conversations.

- [Slack Integration Guide](./slack-integration.md) — AI agents and features overview
- [Slack Admin Guide](./slack-admin-guide.md) — App setup and workspace management
- [Slack Commands Reference](./slack-commands.md) — Slash commands and @mention patterns

### Jira

Manage issues, sprints, and boards through AI-powered conversations with full JQL search support.

- [Jira Integration Guide](./jira-integration.md) — Setup, features, and webhooks
- [Jira MCP Tools Reference](./jira-mcp-tools.md) — All 40 tools with JQL reference

### Confluence

Create, search, and manage Confluence pages and spaces through natural language.

- [Confluence Integration Guide](./confluence-integration.md) — Setup and features
- [Confluence MCP Tools Reference](./confluence-mcp-tools.md) — All 23 tools with CQL reference

## Troubleshooting

Having issues? See the [Troubleshooting Guide](./troubleshooting.md) for common problems and solutions across all integrations.

## External Service Status Pages

If an integration is not responding, check the external service status:

- [GitHub Status](https://www.githubstatus.com/)
- [Slack Status](https://status.slack.com/)
- [Atlassian Status](https://status.atlassian.com/) (Jira and Confluence)

## Related Documentation

- [GitHub Slack Notifications](../github-slack-notifications.md) — Get GitHub events delivered to Slack DMs
- [Organization Slack Integration](../org-slack-self-service.md) — Self-service Slack workspace connection
- [Slack Multi-Workspace OAuth](../slack-multi-workspace-oauth.md) — Multi-workspace setup
- [Slack Model Configuration](../slack-model-config.md) — Configure AI models per channel
