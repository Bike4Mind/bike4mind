---
title: Jira Integration
description: Connect Jira to Bike4Mind for AI-powered issue management, sprint tracking, and real-time webhooks
sidebar_position: 1
tags: [jira, atlassian, integration, oauth, webhooks]
---

# Jira Integration

Connect your Atlassian account to Bike4Mind and let AI agents manage Jira issues, track sprints, search with JQL, and receive real-time webhook notifications — all through natural conversation.

## Overview

With the Jira integration, you can:

- **Manage issues** — create, update, delete, search, transition, and assign issues
- **Bulk operations** — create or update up to 50 issues at once
- **Sprint management** — create, start, close sprints, and move issues between them
- **Board views** — browse Scrum and Kanban boards with configurable grouping
- **JQL search** — powerful Jira Query Language search from conversations
- **Issue links** — create dependencies, duplicates, and other relationships
- **Attachments** — upload, download, and manage issue attachments
- **Webhooks** — receive real-time notifications for issue, comment, and sprint events

## Getting Started

### Step 1: Connect Atlassian

Jira and Confluence share a single Atlassian OAuth connection:

1. Navigate to **Profile → Integrations** in Bike4Mind
2. Click **Connect Atlassian**
3. You'll be redirected to Atlassian to authorize access
4. Review and approve the requested permissions
5. **Select your Atlassian site** (if you have access to multiple sites)
6. You'll be redirected back to Bike4Mind with the connection complete

:::tip One Connection, Two Services
Connecting Atlassian grants access to both Jira and Confluence on your selected site. You don't need to connect them separately.
:::

### Step 2: Start Using Jira Tools

Once connected, AI agents can access your Jira data. Ask in a conversation:

- *"Search for open bugs in the MOBILE project"*
- *"Create a task for updating the API documentation"*
- *"Show me the current sprint for the frontend board"*
- *"Move PROJ-123 to In Progress"*

### Atlassian OAuth Flow

The connection follows a multi-step OAuth 2.0 flow:

1. **Connect** — Initiates OAuth with CSRF-protected state parameter
2. **Authorize** — Redirects to Atlassian for consent
3. **Callback** — Receives authorization code, exchanges for tokens
4. **Site Selection** — Choose which Atlassian site to connect (auto-selected if only one)
5. **Finalize** — Completes connection, enables MCP tools

:::info Token Management
Access tokens are automatically refreshed before expiration. If a token refresh fails, you'll need to reconnect Atlassian in Profile → Integrations.
:::

## Key Features

### Issue Management

| Action | What It Does | Example Prompt |
|---|---|---|
| Create issue | Create with summary, description, type, priority, assignee, labels | *"Create a bug for the login crash on iOS"* |
| Bulk create | Create 2-50 issues/subtasks in one operation | *"Create subtasks for each acceptance criteria"* |
| Update issue | Modify summary, description, priority, labels | *"Update PROJ-123 priority to High"* |
| Bulk update | Update labels on 2-1,000 issues at once | *"Add 'sprint-15' label to all open issues"* |
| Search issues | JQL-powered search with filters and pagination | *"Find all P1 bugs assigned to me"* |
| Delete issue | Permanently remove an issue | *"Delete PROJ-999"* |

### Sprint and Board Management

| Action | What It Does | Example Prompt |
|---|---|---|
| List boards | View all Scrum/Kanban boards | *"Show me all boards in the MOBILE project"* |
| List sprints | View sprints with state filtering | *"Show active sprints for board 42"* |
| Create sprint | Create a new sprint with goals and dates | *"Create a sprint called 'Sprint 16' for next iteration"* |
| Sprint issues | View all issues in a sprint with JQL filtering | *"Show me bugs in the current sprint"* |
| Move to sprint | Move 1-50 issues to a sprint | *"Move these 5 issues to Sprint 16"* |
| Board config | View columns, WIP limits, swimlanes | *"What's the board configuration?"* |

### Workflow Transitions

| Action | What It Does | Example Prompt |
|---|---|---|
| Get transitions | List available status transitions for an issue | *"What transitions are available for PROJ-123?"* |
| Transition issue | Change issue status with optional comment | *"Move PROJ-123 to Done with a comment"* |
| Bulk transition | Transition up to 1,000 issues at once | *"Close all resolved bugs in Sprint 15"* |

### Issue Links

| Action | What It Does |
|---|---|
| List link types | View available link types (Blocks, Duplicates, Relates to, etc.) |
| List issue links | See all links on an issue |
| Create link | Create a dependency between two issues |
| Create multiple links | Batch create up to 10 links |
| Delete link | Remove a link between issues |

## Webhooks

### Overview

Jira webhooks deliver real-time notifications when events happen in your Jira projects. Events are routed to Slack channels or DMs based on subscription preferences.

### Supported Events

| Event | Description |
|---|---|
| `jira:issue_created` | New issue created |
| `jira:issue_updated` | Issue fields changed |
| `jira:issue_deleted` | Issue deleted |
| `comment_created` | New comment on an issue |
| `comment_updated` | Comment edited |
| `comment_deleted` | Comment deleted |
| `sprint_created` | New sprint created |
| `sprint_updated` | Sprint details changed |
| `sprint_started` | Sprint started |
| `sprint_closed` | Sprint completed |
| `sprint_deleted` | Sprint removed |

### Webhook Configuration

Organization admins manage Jira webhook configs:

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/webhooks/jira/config` | Create webhook config |
| `GET` | `/api/webhooks/jira/config` | Get config (secret masked) |
| `PUT` | `/api/webhooks/jira/config` | Update config |
| `DELETE` | `/api/webhooks/jira/config` | Delete config and subscriptions |

### Webhook Subscriptions

Individual users subscribe to specific events:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/webhooks/jira/subscriptions` | List your subscriptions |
| `POST` | `/api/webhooks/jira/subscriptions` | Create a subscription |
| `PUT` | `/api/webhooks/jira/subscriptions/{id}` | Update a subscription |
| `DELETE` | `/api/webhooks/jira/subscriptions/{id}` | Delete a subscription |

Subscriptions support filters by project, priority, and issue type, with delivery to Slack channels or DMs.

### Secret Rotation

Rotate the webhook secret without downtime:

1. Call the rotation endpoint to generate a new secret
2. Both old and new secrets are accepted for **24 hours**
3. Update the secret in your Jira webhook configuration
4. After 24 hours, only the new secret is accepted

### Circuit Breaker

| Threshold | Behavior |
|---|---|
| **10 consecutive failures** | Subscription auto-disabled |
| **Re-enable** | User manually re-enables after investigating |

### Webhook Rate Limits

| Limit | Value |
|---|---|
| Incoming webhooks | 120 requests/minute per config |
| Window | 60-second sliding window |
| Payload size | 1 MB maximum |

:::warning Rate Limit Exceeded
When the rate limit is exceeded, webhooks are rejected with `429 Too Many Requests`. Jira will retry with exponential backoff.
:::

## Permissions and Scopes

The Atlassian OAuth integration requests these scopes for Jira:

| Scope | Purpose |
|---|---|
| `read:jira-work` | Read issues, projects, boards, sprints |
| `write:jira-work` | Create and update issues, transitions, comments |
| `manage:jira-project` | Project configuration and settings |
| `manage:jira-configuration` | Workflow and field configuration |

## Rate Limits

Atlassian API enforces rate limits:

| Type | Limit | Notes |
|---|---|---|
| REST API | Varies by endpoint | Typically 100-500 requests/minute |
| Bulk operations | Subject to standard limits | Each item in bulk counts as a request |
| Search (JQL) | Rate limited separately | Complex queries may take longer |

:::info Atlassian Rate Limit Behavior
When rate limited, Atlassian returns a `429` status with a `Retry-After` header. Bike4Mind surfaces these errors in the conversation with guidance on when to retry.
:::

## Known Limitations

- **Single site connection** — you can connect to one Atlassian site at a time. To switch sites, disconnect and reconnect.
- **Subtask depth** — only one level of subtasks is supported (no nested subtasks)
- **Bulk operations** — create supports 2-50 items, update supports 2-1,000, transition supports 1-1,000
- **JQL complexity** — very complex JQL queries may time out on large instances
- **Attachment size** — uploads are limited by Jira's configured attachment size limit
- **Webhook payloads** — only sanitized data is stored (sensitive fields stripped before storage)

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| `401 Unauthorized` | Token expired or revoked | Reconnect Atlassian in Profile → Integrations |
| `403 Forbidden` | Insufficient project permissions | Verify your Jira permissions for the project |
| `404 Not Found` | Issue, project, or board doesn't exist | Check the issue key or project key |
| `400 Bad Request` | Invalid JQL, missing required fields | Check error details for specifics |
| `429 Too Many Requests` | Rate limit exceeded | Wait for the retry-after period |

## Troubleshooting

For common issues, see the [Troubleshooting Guide](./troubleshooting.md#jira).

**Quick fixes:**

- **"Site not found"** → Verify your Atlassian site URL is correct
- **"Permission denied"** → Check your Jira project role assignments
- **"Token expired"** → Reconnect Atlassian in Profile → Integrations
- **Webhook not delivering** → Check that the webhook URL and secret are correctly configured in Jira

## Related Documentation

- [Jira MCP Tools Reference](./jira-mcp-tools.md) — All 40 tools with JQL reference
- [Confluence Integration](./confluence-integration.md) — Shared Atlassian OAuth
- [Troubleshooting](./troubleshooting.md) — Cross-integration troubleshooting guide
- [External Integrations Overview](./index.md) — All integrations at a glance
