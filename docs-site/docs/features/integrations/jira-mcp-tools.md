---
title: Jira MCP Tools Reference
description: Complete reference for all 40 Jira MCP tools available in Bike4Mind for AI-powered project management
sidebar_position: 2
tags: [jira, mcp, tools, reference, api, jql]
---

# Jira MCP Tools Reference

This reference documents all 40 Jira MCP tools available through the Bike4Mind Atlassian integration, organized by category.

## Issue Management (7 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `jira_get_issue` | Retrieve an issue by key (e.g., PROJ-123) with optional expanded fields | `issueKey`, `expand[]` |
| `jira_create_issue` | Create an issue with summary, description, type, priority, assignee, and labels | `projectKey`, `summary`, `issueTypeName`, `description`, `priority`, `assignee`, `labels`, `parentKey` |
| `jira_bulk_create_issues` | Create 2-50 issues or subtasks in a single call | `issues[]` (each with `projectKey`, `summary`, `issueTypeName`, etc.) |
| `jira_update_issue` | Update existing issue fields (summary, description, priority, labels) | `issueKey`, `summary`, `description`, `priority`, `labels[]` |
| `jira_bulk_update_issues` | Update labels on 2-1,000 issues at once (ADD/REMOVE/SET) | `issueIdsOrKeys[]`, `labels` (with `action`) |
| `jira_search_issues` | Search issues using JQL with pagination and field selection | `jql`, `startAt`, `maxResults`, `fields[]`, `expand[]` |
| `jira_delete_issue` | Permanently delete an issue | `issueKey` |

:::danger Destructive Actions
`jira_delete_issue` permanently removes an issue and all its data. This cannot be undone. Consider transitioning to a "Cancelled" status instead.
:::

## Projects and Configuration (4 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `jira_list_projects` | List all accessible Jira projects with optional search | `maxResults`, `query`, `expand` |
| `jira_get_project` | Get detailed project information | `projectKey`, `expand[]` |
| `jira_list_issue_types` | List available issue types for a project (Task, Epic, Subtask, etc.) | `projectKey` |
| `jira_list_project_members` | List all project members grouped by role with deduplication | `projectKey` |

## Workflow and Comments (5 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `jira_add_comment` | Add a comment to an issue | `issueKey`, `body` |
| `jira_get_transitions` | Get available workflow transitions for an issue | `issueKey` |
| `jira_update_issue_transition` | Execute a workflow transition to change issue status | `issueKey`, `transitionId`, `comment` |
| `jira_bulk_transition_issues` | Transition 1-1,000 issues to new statuses at once | `issues[]` (each with `issueIdOrKey`, `transitionId`) |
| `jira_assign_issue` | Assign an issue to a user | `issueKey`, `accountId` |

:::tip Transition Workflow
Always call `jira_get_transitions` first to get the available transition IDs, then use `jira_update_issue_transition` with the correct ID.
:::

## User Management (5 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `jira_get_current_user` | Get info about the authenticated Jira user | — |
| `jira_search_users` | Search for users by name, email, or username | `query`, `maxResults` |
| `jira_list_watchers` | Get all watchers for an issue | `issueKey` |
| `jira_add_watcher` | Add a user as watcher to an issue | `issueKey`, `userIdentifier` |
| `jira_remove_watcher` | Remove a watcher from an issue | `issueKey`, `userIdentifier` |

## Issue Links (5 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `jira_list_link_types` | List all available link types (Blocks, Duplicates, Relates to, etc.) | — |
| `jira_list_issue_links` | Get all links for a specific issue | `issueKey` |
| `jira_create_issue_link` | Create a link between two issues | `linkType`, `sourceIssue`, `targetIssue` |
| `jira_create_issue_links` | Create multiple links (max 10 per call) | `links[]` (each with `linkType`, `sourceIssue`, `targetIssue`) |
| `jira_delete_issue_link` | Delete a link between two issues | `sourceIssue`, `targetIssue`, `linkType` |

## Attachments (4 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `jira_list_attachments` | List all attachments on an issue | `issueKey` |
| `jira_upload_attachment` | Upload a file to an issue (supports Slack files and base64 content) | `issueKey`, `filename`, `content`, `slackFileUrl`, `mimeType` |
| `jira_download_attachment` | Download an attachment by ID (returns base64-encoded) | `attachmentId` |
| `jira_delete_attachment` | Delete an attachment from an issue | `attachmentId`, `filename` |

:::tip Slack File Sharing
Use the `slackFileUrl` parameter to attach files shared in Slack directly to Jira issues without downloading them first.
:::

## Agile / Boards (10 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `jira_list_boards` | List all Jira boards (Scrum/Kanban/Simple) | `projectKeyOrId`, `type`, `name`, `startAt`, `maxResults` |
| `jira_get_board` | Get details of a specific board | `boardId` |
| `jira_list_sprints` | List sprints with state filtering (future/active/closed) | `boardId`, `state`, `startAt`, `maxResults` |
| `jira_get_sprint` | Get details of a specific sprint | `sprintId` |
| `jira_create_sprint` | Create a new sprint for a Scrum board | `name`, `boardId`, `goal`, `startDate`, `endDate` |
| `jira_update_sprint` | Update sprint name, goal, dates, or state (start/close) | `sprintId`, `name`, `goal`, `startDate`, `endDate`, `state` |
| `jira_get_sprint_issues` | Get all issues in a sprint with JQL filtering | `sprintId`, `jql`, `startAt`, `maxResults` |
| `jira_move_issues_to_sprint` | Move 1-50 issues to a sprint | `sprintId`, `issues[]` |
| `jira_get_board_configuration` | Get board configuration (columns, WIP limits, swimlanes) | `boardId` |
| `jira_get_board_issues` | Get issues on a board with JQL and grouping | `boardId`, `jql`, `groupBy`, `startAt`, `maxResults` |

## JQL Quick Reference

JQL (Jira Query Language) is used with `jira_search_issues`, `jira_get_sprint_issues`, and `jira_get_board_issues`.

### Basic Syntax

```
field operator value [AND/OR field operator value]
```

### Common Queries

| Query | Description |
|---|---|
| `project = PROJ AND status = "In Progress"` | Issues in progress for a project |
| `assignee = currentUser() AND resolution = Unresolved` | Your unresolved issues |
| `priority = High AND created >= -7d` | High priority issues from the last 7 days |
| `labels in (bug, critical) AND status != Done` | Open issues with specific labels |
| `sprint in openSprints()` | Issues in any active sprint |
| `sprint = "Sprint 16" AND type = Bug` | Bugs in a specific sprint |
| `text ~ "login timeout"` | Full-text search across summary and description |
| `issuetype = Epic AND status = "To Do"` | Unstarted epics |
| `parent = PROJ-100` | Subtasks of a specific issue |
| `updated >= -24h ORDER BY updated DESC` | Recently updated issues |

### Operators

| Operator | Usage | Example |
|---|---|---|
| `=` | Exact match | `status = "Done"` |
| `!=` | Not equal | `status != "Done"` |
| `in` | In list | `priority in (High, Critical)` |
| `not in` | Not in list | `status not in (Done, Closed)` |
| `~` | Contains (text search) | `summary ~ "login"` |
| `>=`, `<=` | Comparison | `created >= "2024-01-01"` |
| `is EMPTY` | Field has no value | `assignee is EMPTY` |
| `is not EMPTY` | Field has a value | `labels is not EMPTY` |

### Functions

| Function | Description | Example |
|---|---|---|
| `currentUser()` | The authenticated user | `assignee = currentUser()` |
| `openSprints()` | All active sprints | `sprint in openSprints()` |
| `closedSprints()` | All completed sprints | `sprint in closedSprints()` |
| `now()` | Current date/time | `due <= now()` |
| `-7d`, `-24h` | Relative date | `created >= -7d` |

## Permissions Required

All Jira tools require the Atlassian OAuth connection with these scopes:

| Scope | Tools That Require It |
|---|---|
| `read:jira-work` | All read/list/search/get tools |
| `write:jira-work` | All create/update/delete/transition tools |
| `manage:jira-project` | Project-level configuration tools |
| `manage:jira-configuration` | Workflow and field configuration |

## Rate Limits

| API Type | Limit | Notes |
|---|---|---|
| REST API | Varies by endpoint | Typically 100-500 requests/minute |
| Bulk operations | Each item counts separately | 50 creates = 50 requests |
| Search (JQL) | Rate limited separately | Complex queries may take longer |

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| `401 Unauthorized` | Token expired or revoked | Reconnect Atlassian in Profile → Integrations |
| `403 Forbidden` | Insufficient project permissions | Verify your Jira project role |
| `404 Not Found` | Issue, project, or board doesn't exist | Check the issue key or project key |
| `400 Bad Request` | Invalid JQL, missing required fields, invalid transition | Check error message for specifics |
| `429 Too Many Requests` | Rate limit exceeded | Wait for the retry-after period |

## Related Documentation

- [Jira Integration](./jira-integration.md) — Setup, features, and webhooks
- [Confluence MCP Tools Reference](./confluence-mcp-tools.md) — Confluence tools (shared Atlassian connection)
- [External Integrations Overview](./index.md) — All integrations at a glance
