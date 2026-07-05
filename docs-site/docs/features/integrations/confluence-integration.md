---
title: Confluence Integration
description: Connect Confluence to Bike4Mind for AI-powered page management, search, and collaboration
sidebar_position: 1
tags: [confluence, atlassian, integration, wiki, pages]
---

# Confluence Integration

Connect your Atlassian account to Bike4Mind and let AI agents create, search, and manage Confluence pages, comments, and attachments — all through natural conversation.

## Overview

With the Confluence integration, you can:

- **Page management** — create, update, search, and delete pages
- **Search** — find content using CQL (Confluence Query Language)
- **Comments** — create, reply to, update, and delete page comments (including inline comments)
- **Restrictions** — view and manage page access restrictions for users and groups
- **Attachments** — upload, download, list, and delete attachments
- **Spaces** — browse and search across Confluence spaces

## Getting Started

### Step 1: Connect Atlassian

Confluence and Jira share a single Atlassian OAuth connection:

1. Navigate to **Profile → Integrations** in Bike4Mind
2. Click **Connect Atlassian**
3. Authorize access on the Atlassian consent screen
4. Select your Atlassian site (if you have multiple)
5. The connection is complete — both Jira and Confluence are now available

:::tip Already Connected Jira?
If you've already connected Jira, Confluence is automatically available. No additional setup needed.
:::

### Step 2: Start Using Confluence Tools

Once connected, ask AI agents about your Confluence content:

- *"Find our deployment runbook in Confluence"*
- *"Create a meeting notes page in the Engineering space"*
- *"Show me the child pages under Architecture"*
- *"Add a comment to the API documentation page"*

## Key Features

### Page Management

| Action | What It Does | Example Prompt |
|---|---|---|
| Get page | Retrieve a page by ID or search by title and space | *"Find the 'Sprint Retro' page in the TEAM space"* |
| Create page | Create a new page in a space with optional parent and labels | *"Create a meeting notes page in Engineering"* |
| Update page | Update page title and/or content | *"Update the deployment checklist with the new step"* |
| Delete page | Permanently remove a page | *"Delete the outdated draft page"* |
| List pages | List pages in a space or across all spaces | *"Show all pages in the Architecture space"* |
| Get children | Retrieve child pages for a given page | *"What are the subpages under API Docs?"* |

:::warning Confluence Storage Format
Page content is stored in Confluence Storage Format (XHTML-based). When creating or updating pages, the AI agent handles the conversion from natural language to storage format automatically.
:::

### Search (CQL)

Search across all Confluence content using CQL (Confluence Query Language):

- *"Search for pages about authentication"*
- *"Find recently updated pages in the Engineering space"*
- *"Search for pages with the 'architecture' label"*

See the [Confluence MCP Tools Reference](./confluence-mcp-tools.md#cql-quick-reference) for CQL syntax.

### Comments

| Action | What It Does | Example Prompt |
|---|---|---|
| Create comment | Add a page-level or inline comment | *"Add a comment to the API docs about the new endpoint"* |
| Reply to comment | Create a threaded reply | *"Reply to the review comment about error handling"* |
| List comments | Show all comments with threaded replies | *"Show comments on the deployment page"* |
| Update comment | Edit your own comment | *"Update my comment to include the fix details"* |
| Delete comment | Remove your own comment | *"Delete my draft comment"* |

:::info Comment Ownership
You can only update or delete comments that you created. Attempting to modify others' comments will return a permission error.
:::

### Page Restrictions

| Action | What It Does |
|---|---|
| Get restrictions | View current view/edit restrictions on a page |
| Add restrictions | Restrict view or edit access to specific users or groups (supports bulk) |
| Remove restrictions | Remove restrictions for users or groups (supports bulk) |

### Attachments

| Action | What It Does |
|---|---|
| List attachments | Show all files attached to a page |
| Upload attachment | Upload a file (supports Slack files and base64 content, auto-embeds images) |
| Download attachment | Download a file by ID (returns base64-encoded content) |
| Delete attachment | Remove a file from a page |

### Space Management

| Action | What It Does |
|---|---|
| List spaces | Browse all available Confluence spaces |
| Get space | View space details by key |
| Personal space | Access your personal Confluence space |

## Permissions and Scopes

The Atlassian OAuth integration requests these scopes for Confluence:

| Scope | Purpose |
|---|---|
| `read:confluence-content.all` | Read pages, comments, attachments, and spaces |
| `write:confluence-content` | Create and update pages, comments, and attachments |
| `manage:confluence-configuration` | Manage page restrictions and space configuration |

## Rate Limits

Atlassian API enforces rate limits for Confluence:

| Type | Limit | Notes |
|---|---|---|
| REST API | Varies by endpoint | Typically 100-500 requests/minute |
| Search (CQL) | Rate limited separately | Complex queries may take longer |
| Attachment uploads | Subject to size limits | Confluence site-level attachment size limit applies |

:::info Rate Limit Behavior
When rate limited, Atlassian returns a `429` status with a `Retry-After` header. Bike4Mind surfaces these errors in the conversation with guidance on when to retry.
:::

## Known Limitations

- **Single site** — connects to one Atlassian site at a time (shared with Jira)
- **Storage format** — complex page layouts (macros, custom elements) may not be fully supported when creating or updating via AI
- **Comment editing** — you can only edit/delete your own comments
- **Attachment size** — limited by your Confluence instance's configured maximum (typically 10-200 MB)
- **Page versioning** — updates always create a new version; AI cannot access or restore previous versions
- **Space creation** — creating new spaces is not supported through MCP tools

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| `401 Unauthorized` | Token expired or revoked | Reconnect Atlassian in Profile → Integrations |
| `403 Forbidden` | No access to the space or page | Verify your Confluence permissions |
| `404 Not Found` | Page, space, or comment doesn't exist | Check the page ID or space key |
| `400 Bad Request` | Invalid CQL, malformed content | Check error details for specifics |
| `409 Conflict` | Page version conflict (concurrent edits) | Retry the update — it will use the latest version |
| `429 Too Many Requests` | Rate limit exceeded | Wait for the retry-after period |

## Troubleshooting

For common issues, see the [Troubleshooting Guide](./troubleshooting.md#confluence).

**Quick fixes:**

- **"Space not found"** → Verify the space key is correct (case-sensitive)
- **"Permission denied"** → Check your Confluence space permissions
- **"Token expired"** → Reconnect Atlassian in Profile → Integrations
- **"Page not found by title"** → Ensure the title is exact; use search (CQL) for fuzzy matching

## Related Documentation

- [Confluence MCP Tools Reference](./confluence-mcp-tools.md) — All 23 tools with CQL reference
- [Jira Integration](./jira-integration.md) — Shared Atlassian OAuth
- [Troubleshooting](./troubleshooting.md) — Cross-integration troubleshooting guide
- [External Integrations Overview](./index.md) — All integrations at a glance
