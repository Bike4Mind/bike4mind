---
title: Confluence MCP Tools Reference
description: Complete reference for all 23 Confluence MCP tools available in Bike4Mind for AI-powered wiki management
sidebar_position: 2
tags: [confluence, mcp, tools, reference, api, cql]
---

# Confluence MCP Tools Reference

This reference documents all 23 Confluence MCP tools available through the Bike4Mind Atlassian integration, organized by category.

## Pages (7 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `confluence_get_page` | Retrieve a page by ID or search by title within a space | `pageId`, `title`, `spaceKey`, `includeContent` |
| `confluence_create_page` | Create a new page in a space with optional parent and labels | `spaceId`, `title`, `content`, `parentId`, `labels[]` |
| `confluence_update_page` | Update page title and/or content (creates a new version) | `pageId`, `currentTitle`, `newTitle`, `content` |
| `confluence_delete_page` | Permanently delete a page | `pageId` |
| `confluence_search` | Search content using CQL (Confluence Query Language) | `query`, `spaceKey`, `limit` |
| `confluence_list_pages` | List pages in a space or across all spaces | `spaceId`, `usePersonalSpace`, `limit` |
| `confluence_get_page_children` | Retrieve child pages for a given page | `pageId`, `limit` |

:::danger Destructive Action
`confluence_delete_page` permanently removes a page and all its content, comments, and attachments. This cannot be undone.
:::

## Spaces (3 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `confluence_list_spaces` | List available Confluence spaces | `limit`, `type`, `expand` |
| `confluence_get_space` | Fetch space details by key | `spaceKey`, `expand` |
| `confluence_get_current_user` | Get authenticated user profile and personal space | — |

## Comments (6 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `confluence_create_comment` | Create a page-level or inline comment | `pageId`, `content`, `inlineOriginalSelection` |
| `confluence_reply_to_comment` | Reply to an existing comment (threaded discussion) | `pageId`, `parentCommentId`, `content` |
| `confluence_list_comments` | List comments on a page with threaded replies | `pageId`, `limit`, `start` |
| `confluence_get_comment` | Get details of a specific comment | `commentId` |
| `confluence_update_comment` | Update an existing comment (own comments only) | `commentId`, `content` |
| `confluence_delete_comment` | Permanently delete a comment (own comments only) | `commentId` |

:::tip Inline Comments
Use the `inlineOriginalSelection` parameter in `confluence_create_comment` to create inline comments that annotate specific text on a page.
:::

## Restrictions (3 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `confluence_get_page_restrictions` | Get current view/edit restrictions on a page | `pageId` |
| `confluence_add_page_restriction` | Add view or edit restrictions for users/groups (supports bulk) | `pageId`, `operation`, `restrictionType`, `subject` or `restrictions[]` |
| `confluence_remove_page_restriction` | Remove restrictions from a page (supports bulk) | `pageId`, `operation`, `restrictionType`, `subject` or `restrictions[]` |

**Restriction operations:**

| Operation | Description |
|---|---|
| `read` | Controls who can view the page |
| `update` | Controls who can edit the page |

**Restriction types:**

| Type | Description |
|---|---|
| `user` | Restrict to specific user |
| `group` | Restrict to a group |

## Attachments (4 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `confluence_list_attachments` | List all attachments on a page | `pageId`, `limit` |
| `confluence_upload_attachment` | Upload a file to a page (supports Slack files, auto-embeds images) | `pageId`, `filename`, `content`, `slackFileUrl`, `mimeType`, `comment` |
| `confluence_download_attachment` | Download an attachment by ID (returns base64-encoded content) | `attachmentId` |
| `confluence_delete_attachment` | Delete an attachment from a page | `attachmentId`, `filename` |

:::tip Image Auto-Embedding
When uploading image files, they are automatically embedded in the page content. Other file types are added as downloadable attachments.
:::

## CQL Quick Reference

CQL (Confluence Query Language) is used with `confluence_search`.

### Basic Syntax

```
field operator value [AND/OR field operator value]
```

### Common Queries

| Query | Description |
|---|---|
| `text ~ "deployment guide"` | Full-text search across all content |
| `space = "ENG" AND type = page` | Pages in a specific space |
| `label = "architecture"` | Content with a specific label |
| `creator = currentUser()` | Content you created |
| `lastModified >= "2024-01-01"` | Recently modified content |
| `ancestor = 12345` | Pages under a specific parent page |
| `title = "API Documentation"` | Exact title match |
| `title ~ "API"` | Title contains "API" |
| `space = "ENG" AND label in ("api", "docs")` | Multiple label filter |
| `type = page AND lastModified >= now("-7d")` | Pages modified in the last 7 days |

### Operators

| Operator | Usage | Example |
|---|---|---|
| `=` | Exact match | `space = "ENG"` |
| `!=` | Not equal | `type != "comment"` |
| `~` | Contains (text search) | `text ~ "authentication"` |
| `in` | In list | `label in ("api", "docs")` |
| `not in` | Not in list | `space not in ("ARCHIVE")` |
| `>=`, `<=` | Date/number comparison | `lastModified >= "2024-01-01"` |

### Fields

| Field | Description | Example |
|---|---|---|
| `text` | Full-text search (title + body) | `text ~ "webhook"` |
| `title` | Page title | `title = "Meeting Notes"` |
| `space` | Space key | `space = "ENG"` |
| `type` | Content type (page, blogpost, comment) | `type = page` |
| `label` | Content labels | `label = "architecture"` |
| `creator` | Content creator | `creator = currentUser()` |
| `lastModified` | Last modification date | `lastModified >= now("-30d")` |
| `created` | Creation date | `created >= "2024-01-01"` |
| `ancestor` | Parent page ID (includes all descendants) | `ancestor = 12345` |
| `parent` | Direct parent page ID | `parent = 12345` |

### Functions

| Function | Description |
|---|---|
| `currentUser()` | The authenticated user |
| `now()` | Current date/time |
| `now("-7d")` | Relative date (7 days ago) |

## Permissions Required

All Confluence tools require the Atlassian OAuth connection with these scopes:

| Scope | Tools That Require It |
|---|---|
| `read:confluence-content.all` | All read/list/search/get tools |
| `write:confluence-content` | All create/update/delete tools |
| `manage:confluence-configuration` | Restriction management tools |

## Rate Limits

| API Type | Limit | Notes |
|---|---|---|
| REST API | Varies by endpoint | Typically 100-500 requests/minute |
| Search (CQL) | Rate limited separately | Complex queries may take longer |
| Attachment uploads | Subject to size limits | Confluence site configuration applies |

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| `401 Unauthorized` | Token expired or revoked | Reconnect Atlassian in Profile → Integrations |
| `403 Forbidden` | No access to space or page | Verify your Confluence permissions |
| `404 Not Found` | Page, space, or comment doesn't exist | Check the page ID or space key |
| `400 Bad Request` | Invalid CQL, malformed content | Check error details for specifics |
| `409 Conflict` | Page version conflict | Retry — will use latest version automatically |
| `429 Too Many Requests` | Rate limit exceeded | Wait for the retry-after period |

## Related Documentation

- [Confluence Integration](./confluence-integration.md) — Setup and getting started
- [Jira MCP Tools Reference](./jira-mcp-tools.md) — Jira tools (shared Atlassian connection)
- [External Integrations Overview](./index.md) — All integrations at a glance
