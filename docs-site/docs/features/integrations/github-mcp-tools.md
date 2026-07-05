---
title: GitHub MCP Tools Reference
description: Complete reference for all 46 GitHub MCP tools available in Bike4Mind for AI-powered GitHub management
sidebar_position: 3
tags: [github, mcp, tools, reference, api]
---

# GitHub MCP Tools Reference

This reference documents all 46 GitHub MCP tools available through the Bike4Mind integration, organized by category.

## User (1 tool)

| Tool | Description | Key Parameters |
|---|---|---|
| `get_authenticated_user` | Get details about the authenticated GitHub user including login, name, email, company, location, and activity stats | — |

## Issues (5 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `create_issue` | Create a new issue with title, body, labels, and assignees. Validates that labels exist in the repo. | `owner`, `repo`, `title`, `body`, `labels[]`, `assignees[]` |
| `update_issue` | Modify an issue's title, body, state, labels, assignees, or type (Bug/Feature/Task) | `owner`, `repo`, `issue_number`, `title`, `body`, `state`, `labels[]`, `assignees[]` |
| `list_issues` | List repository issues with filtering by state, labels, assignee, or type. Supports pagination. | `owner`, `repo`, `state`, `labels`, `assignee`, `type`, `page`, `per_page` |
| `get_issue` | Get detailed issue information including labels, assignees, milestone, type, and associated projects | `owner`, `repo`, `issue_number` |
| `create_issue_comment` | Add a comment to an existing issue | `owner`, `repo`, `issue_number`, `body` |

:::tip Issue Types
GitHub issue types (Bug, Feature, Task) are organization-level features. Use `list_org_issue_types` to see available types before assigning them.
:::

## Labels (4 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `create_label` | Create a new label with name, hex color, and optional description | `owner`, `repo`, `name`, `color`, `description` |
| `update_label` | Update a label's name, color, or description | `owner`, `repo`, `name`, `new_name`, `color`, `description` |
| `delete_label` | Permanently delete a label from a repository | `owner`, `repo`, `name` |
| `list_labels` | List all labels in a repository with pagination | `owner`, `repo`, `page`, `per_page` |

:::danger Destructive Action
`delete_label` permanently removes a label and unlinks it from all issues. This cannot be undone.
:::

## Search (1 tool)

| Tool | Description | Key Parameters |
|---|---|---|
| `search_code` | Search code across repositories using GitHub query syntax. Supports language, file, and repo filters. | `query`, `language`, `filename`, `repo` |

**Search syntax examples:**
- `useAuth language:typescript` — Search for `useAuth` in TypeScript files
- `TODO repo:org/frontend` — Find TODOs in a specific repo
- `filename:package.json express` — Find `express` in `package.json` files

## Repositories (2 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `list_repositories` | List repositories you have access to, filterable by visibility, affiliation, and sortable | `visibility`, `affiliation`, `sort`, `direction`, `page`, `per_page` |
| `get_repository` | Get detailed repository info including description, language, topics, license, forks, stars, and features | `owner`, `repo` |

## Branches (2 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `list_branches` | List all branches with protection status and commit info | `owner`, `repo`, `page`, `per_page` |
| `create_branch` | Create a new branch from a source branch (defaults to main). Includes name validation. | `owner`, `repo`, `branch`, `source_branch` |

## File Contents (1 tool)

| Tool | Description | Key Parameters |
|---|---|---|
| `create_or_update_file` | Create or update a file in a repository. Auto-detects if file exists, supports custom committer info. | `owner`, `repo`, `path`, `content`, `message`, `branch`, `committer` |

:::warning One File Per Commit
This tool creates one commit per file. For multi-file changes, each file requires a separate tool call and creates a separate commit.
:::

## Commits (2 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `list_commits` | View commit history with optional filtering by branch/SHA, file path, or author. Includes stats. | `owner`, `repo`, `sha`, `path`, `author`, `page`, `per_page` |
| `get_commit` | Get detailed commit information including author, stats, and files changed with patch content | `owner`, `repo`, `ref` |

## Pull Requests (7 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `list_pull_requests` | List PRs with filtering by state, author, and labels. Supports pagination. | `owner`, `repo`, `state`, `author`, `labels`, `page`, `per_page` |
| `get_pull_request` | Get detailed PR info including diffs, commits, mergeability, and review comments | `owner`, `repo`, `pull_number` |
| `get_pull_request_files` | Get list of files changed in a PR with patch content, additions/deletions | `owner`, `repo`, `pull_number` |
| `get_pull_request_diff` | Get raw unified diff for a PR (may fail for large diffs) | `owner`, `repo`, `pull_number` |
| `create_pull_request` | Create a new PR with title, body, head/base branches. Defaults to draft. Includes idempotency check. | `owner`, `repo`, `title`, `body`, `head`, `base`, `draft` |
| `update_pull_request` | Update PR title, body, state, base branch, draft status, or maintainer permissions | `owner`, `repo`, `pull_number`, `title`, `body`, `state`, `base`, `draft` |
| `merge_pull_request` | Merge a PR with configurable method (merge/squash/rebase) and optional SHA validation | `owner`, `repo`, `pull_number`, `merge_method`, `commit_title`, `commit_message`, `sha` |

## Reviews (3 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `create_review` | Create a review (APPROVE/REQUEST_CHANGES/COMMENT) with optional inline file comments on specific lines | `owner`, `repo`, `pull_number`, `event`, `body`, `comments[]` |
| `approve_pr` | Approve a pull request with optional message. Convenience wrapper around `create_review`. | `owner`, `repo`, `pull_number`, `body` |
| `request_changes` | Request changes with required explanation and optional inline comments. Convenience wrapper. | `owner`, `repo`, `pull_number`, `body`, `comments[]` |

## Projects v2 (5 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `list_org_projects` | List all GitHub Projects v2 for an organization with pagination | `org`, `first`, `after` |
| `list_project_fields` | List all fields (Status, Priority, Size, etc.) for a project with available options | `project_id` |
| `get_project_item` | Get an issue as a project item with all field values. Scans up to 1,000 items. | `project_id`, `issue_url` |
| `add_issue_to_project` | Add an issue to a project. Required before updating project fields. | `project_id`, `issue_url` |
| `update_project_item_fields` | Update multiple fields at once on a project item (single-select, text, number, date, iteration) | `project_id`, `item_id`, `fields` |

:::tip Projects v2 Workflow
To update an issue's project fields: (1) `add_issue_to_project` first, then (2) `update_project_item_fields`. You cannot update fields on an issue that isn't in the project.
:::

## Milestones (4 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `create_milestone` | Create a milestone with title, description, due date, and state | `owner`, `repo`, `title`, `description`, `due_on`, `state` |
| `update_milestone` | Update milestone title, description, due date, or state. Can reopen closed milestones. | `owner`, `repo`, `milestone_number`, `title`, `description`, `due_on`, `state` |
| `list_milestones` | List milestones with filtering by state, sorting, and progress calculations | `owner`, `repo`, `state`, `sort`, `direction` |
| `close_milestone` | Close (complete) a milestone. Use `update_milestone` with `state="open"` to reopen. | `owner`, `repo`, `milestone_number` |

## Workflows / GitHub Actions (4 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `list_workflow_runs` | List GitHub Actions runs with filtering by branch, status, or trigger event. Includes PR associations. | `owner`, `repo`, `branch`, `status`, `event`, `page`, `per_page` |
| `get_workflow_run_details` | Get detailed run info including jobs and steps with failure summaries | `owner`, `repo`, `run_id` |
| `get_workflow_run_logs` | Download and summarize all logs for a run, with error extraction. Can filter to failed jobs only. | `owner`, `repo`, `run_id`, `failed_only` |
| `get_job_logs` | Get logs for a specific job with optional step filtering and error summarization | `owner`, `repo`, `job_id`, `step`, `tail` |

## Issue Types (1 tool)

| Tool | Description | Key Parameters |
|---|---|---|
| `list_org_issue_types` | List all available issue types (Bug, Feature, Task) for an organization | `org` |

## Permissions Required

All tools require the GitHub OAuth connection with these scopes:

| Scope | Tools That Require It |
|---|---|
| `repo` | All repository, issue, PR, branch, commit, file, label, milestone, and workflow tools |
| `read:org` | `list_org_issue_types`, `list_org_projects` |
| `read:user` | `get_authenticated_user` |
| `project` | All Projects v2 tools |

## Rate Limits

| API Type | Limit | Affected Tools |
|---|---|---|
| REST API | 5,000 requests/hour | Most tools |
| Search API | 30 requests/minute | `search_code` |
| GraphQL API | 5,000 points/hour | Projects v2 tools, draft PR conversion |

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| `401 Unauthorized` | Token expired or revoked | Reconnect GitHub in Profile → Integrations |
| `403 Forbidden` | Rate limit hit or scope insufficient | Wait for reset or reconnect with correct scopes |
| `404 Not Found` | Resource doesn't exist or no access | Verify resource exists and you have permission |
| `422 Unprocessable Entity` | Invalid input | Check error details for the specific validation failure |
| `409 Conflict` | Resource already exists (e.g., duplicate branch name) | Use a different name or check existing resources |

## Related Documentation

- [GitHub Integration](./github-integration.md) — Setup and getting started
- [GitHub Webhooks](./github-webhooks.md) — Real-time event notifications
- [External Integrations Overview](./index.md) — All integrations at a glance
