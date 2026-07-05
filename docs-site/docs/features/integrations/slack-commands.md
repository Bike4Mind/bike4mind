---
title: Slack Commands Reference
description: Complete reference for Bike4Mind slash commands and agent @mention patterns in Slack
sidebar_position: 3
tags: [slack, commands, agents, reference]
---

# Slack Commands Reference

This reference covers all slash commands and agent @mention patterns available in the Bike4Mind Slack integration.

## Slash Commands

### `/b4m`

The primary slash command for Bike4Mind actions.

| Command | Description | Example |
|---|---|---|
| `/b4m help` | Show available commands and agents | `/b4m help` |
| `/b4m status` | Check your connection status (Slack, GitHub, Atlassian) | `/b4m status` |

### `/notebook`

Create and manage notebooks directly from Slack.

| Command | Description | Example |
|---|---|---|
| `/notebook create [title]` | Create a new notebook | `/notebook create Sprint Retrospective` |
| `/notebook list` | List your recent notebooks | `/notebook list` |

## Agent @Mentions

@mention an agent to interact with it. Agents read the full thread context when mentioned in a thread.

### `@agent` — General Assistant

The general-purpose AI agent for questions, explanations, and help.

| Pattern | Description | Example |
|---|---|---|
| `@agent [question]` | Ask any question | `@agent What's the difference between REST and GraphQL?` |
| `@agent help` | Show all available agents and commands | `@agent help` |
| `@agent summarize` | Summarize the current thread | `@agent summarize this discussion` |

### `@dev` — Developer Agent

Specialized for GitHub operations and technical tasks.

| Pattern | Description | Example |
|---|---|---|
| `@dev create issue [description]` | Create a GitHub issue from conversation context | `@dev create issue for the login timeout bug` |
| `@dev search [query]` | Search code across repositories | `@dev search for useAuth hook` |
| `@dev list issues [filters]` | List GitHub issues | `@dev list open bugs in the frontend repo` |
| `@dev create pr [description]` | Create a pull request | `@dev create a PR for the feature branch` |
| `@dev show workflow [repo]` | Show recent CI/CD workflow runs | `@dev show failing workflows on main` |

:::tip Thread Context
When you @mention `@dev` in a thread, it analyzes the entire conversation to create well-formed issues with proper titles, descriptions, and labels extracted from the discussion.
:::

### `@pm` — Project Manager Agent

Specialized for Jira operations and project planning.

| Pattern | Description | Example |
|---|---|---|
| `@pm create ticket [description]` | Create a Jira ticket | `@pm create ticket for the feature request` |
| `@pm create epic [description]` | Create an epic from conversation | `@pm create epic from this planning discussion` |
| `@pm search [JQL or natural language]` | Search Jira issues | `@pm find open bugs in the mobile project` |
| `@pm update [issue-key]` | Update a Jira issue | `@pm move PROJ-123 to In Progress` |
| `@pm sprint status` | Show current sprint status | `@pm what's the sprint burndown?` |

### `@analyst` — Data Analyst Agent

Specialized for data analysis and insights.

| Pattern | Description | Example |
|---|---|---|
| `@analyst summarize [topic]` | Analyze and summarize data | `@analyst summarize our sprint metrics` |
| `@analyst compare [items]` | Compare metrics or approaches | `@analyst compare Q3 and Q4 velocity` |
| `@analyst insights [data]` | Extract insights from shared data | `@analyst what patterns do you see in these error rates?` |

### `@researcher` — Research Agent

Specialized for documentation and knowledge management.

| Pattern | Description | Example |
|---|---|---|
| `@researcher find [topic]` | Search documentation and knowledge bases | `@researcher find our API auth docs` |
| `@researcher create page [title]` | Create a Confluence page | `@researcher create a Confluence page from this meeting` |
| `@researcher summarize [doc]` | Summarize a document or set of results | `@researcher summarize our deployment runbook` |

## Natural Language Support

All agents support natural language variations. You don't need to use exact command syntax:

```
@dev create an issue for the timeout bug we discussed
@dev Can you make a GitHub issue about the login problem?
@dev I need a bug report for the API rate limiting issue
```

All three produce similar results — a GitHub issue with context from the conversation.

## Agent Response Patterns

### Single Response

For simple queries, agents respond with a single message:

```
You: @agent What is a webhook?
Agent: A webhook is an HTTP callback that sends real-time data...
```

### Threaded Response

For complex operations, agents respond in a thread to keep the channel clean:

```
You: @dev create issue for the login timeout bug
Agent: (in thread) Created GitHub issue #456: "Login timeout on slow connections"
       - Repository: org/frontend
       - Labels: bug, authentication
       - Link: https://github.com/org/frontend/issues/456
```

### Confirmation Before Action

For destructive or significant actions, agents ask for confirmation:

```
You: @pm delete PROJ-123
Agent: Are you sure you want to delete PROJ-123 "Update login flow"?
       This action cannot be undone. React with ✅ to confirm.
```

## Tips and Best Practices

- **Be specific** — "create an issue about the login bug" is better than "create an issue"
- **Use threads** — @mention agents in threads to give them conversation context
- **One action per message** — agents handle one request at a time
- **Check connections** — use `/b4m status` to verify your integrations are connected
- **Right agent for the job** — use `@dev` for GitHub, `@pm` for Jira, `@researcher` for Confluence

:::warning Channel Requirement
The Bike4Mind bot must be invited to a channel before agents can respond there. Use `/invite @Bike4Mind Bot` to add it.
:::

## Permissions

| Action | Requires |
|---|---|
| @mention any agent | Bike4Mind account + Slack linked |
| Create GitHub issues | GitHub connected |
| Create Jira tickets | Atlassian connected |
| Create Confluence pages | Atlassian connected |
| Use slash commands | Bot invited to channel |

## Rate Limits

Slack rate limits apply to agent responses:

| Scenario | Limit |
|---|---|
| Messages per channel | 1 message/second |
| File uploads | 20 per minute |
| API calls (general) | Varies by method |

Agents automatically handle rate limiting with retries. You may notice brief delays during peak usage.

## Related Documentation

- [Slack Integration Guide](./slack-integration.md) — Overview and getting started
- [Slack Admin Guide](./slack-admin-guide.md) — App setup and workspace management
- [External Integrations Overview](./index.md) — All integrations at a glance
