---
title: Agents
description: Markdown-defined agents for exploration, planning, implementation, review, and testing
sidebar_position: 7
---

# Agents

The B4M CLI includes a markdown-based agent system that delegates specialized tasks to focused agents. Each agent is defined by a markdown file with YAML frontmatter controlling its model, tools, iterations, and behavior.

## Overview

Agents are lightweight, specialized workers that:
- Are defined declaratively in markdown files
- Run with models optimized for their specific task type
- Have scoped tool access (e.g., read-only for explore/review)
- Return concise summaries to the main agent
- Can run in foreground (blocking) or background (concurrent)

```
┌──────────────────┐
│   Main Agent     │
│  (Full Access)   │
└────────┬─────────┘
         │ agent_delegate
         ▼
┌──────────────────┐     ┌──────────────────┐
│   Explore Agent  │     │  Review Agent    │
│   (Read-only)    │     │  (Read-only)     │
└────────┬─────────┘     └────────┬─────────┘
         │ summary                │ summary
         ▼                        ▼
┌──────────────────────────────────────────┐
│   Main Agent (Continues with results)    │
└──────────────────────────────────────────┘
```

## Built-in Agents

### Explore

Fast, read-only codebase exploration.

| Property | Value |
|----------|-------|
| **Model** | `claude-haiku-4-5` (fast, economical) |
| **Tools** | `file_read`, `grep_search`, `glob_files`, `bash_execute`, `current_datetime`, `math_evaluate` |
| **Iterations** | quick: 4, medium: 10, very_thorough: 20 |
| **Default** | medium |

**When to use:**
- "Find all authentication-related files"
- "Where is the user model defined?"
- "What patterns are used for API routes?"

### Plan

Task breakdown and implementation planning with strong reasoning.

| Property | Value |
|----------|-------|
| **Model** | `claude-opus-4-6` (deep reasoning) |
| **Tools** | `file_read`, `grep_search`, `glob_files`, `bash_execute`, `current_datetime`, `math_evaluate` |
| **Iterations** | quick: 6, medium: 14, very_thorough: 24 |
| **Default** | medium |

**When to use:**
- "Create a plan to implement user authentication"
- "Break down the steps for adding dark mode"
- "Design the architecture for the new feature"

### General-Purpose

Full tool access for implementation tasks.

| Property | Value |
|----------|-------|
| **Model** | Inherits from main session |
| **Tools** | All tools (no restrictions) |
| **Iterations** | quick: 6, medium: 16, very_thorough: 30 |
| **Default** | medium |

**When to use:**
- Writing code, creating files, editing
- Running commands and scripts
- Any task requiring write access

### Review

Code quality analysis with strong analytical model.

| Property | Value |
|----------|-------|
| **Model** | `claude-sonnet-4-5` (balanced reasoning) |
| **Tools** | `file_read`, `grep_search`, `glob_files`, `bash_execute`, `current_datetime` |
| **Iterations** | quick: 6, medium: 16, very_thorough: 30 |
| **Default** | medium |

**When to use:**
- "Review the payment module for security issues"
- "Analyze database queries for performance"
- "Check this code for bugs and edge cases"

### Test

Test execution and failure analysis.

| Property | Value |
|----------|-------|
| **Model** | `claude-sonnet-4-5` |
| **Tools** | `bash_execute`, `file_read`, `grep_search`, `glob_files`, `current_datetime` |
| **Iterations** | quick: 4, medium: 10, very_thorough: 16 |
| **Default** | medium |

**When to use:**
- "Run the test suite and report failures"
- "Execute tests for the auth module"
- "Verify no regressions in the API tests"

### Coordinator

Decomposes complex tasks into subtask pipelines. See [Agent Orchestration](./agent-orchestration.md) for details.

| Property | Value |
|----------|-------|
| **Model** | `claude-opus-4-6` (deep reasoning for decomposition) |
| **Tools** | `decompose_task`, `file_read`, `grep_search`, `glob_files`, `bash_execute`, `current_datetime` |
| **Iterations** | quick: 4, medium: 8, very_thorough: 14 |
| **Default** | medium |

## Agent Definition Format

Agents are defined as markdown files with YAML frontmatter. They are loaded from multiple directories with precedence (highest wins):

1. `.claude/agents/` (project-level, highest priority)
2. `.bike4mind/agents/` (project-level)
3. `~/.claude/agents/` (global)
4. `~/.bike4mind/agents/` (global)
5. Built-in defaults (lowest priority)

### Example Agent Definition

```markdown
---
description: Fast codebase exploration and search
model: claude-haiku-4-5-20251001
allowed-tools:
  - file_read
  - grep_search
  - glob_files
  - bash_execute
denied-tools:
  - create_file
  - edit_file
  - delete_file
max-iterations:
  quick: 4
  medium: 10
  very_thorough: 20
default-thoroughness: medium
shared-context:
  - read
  - write
---

You are a code exploration specialist. Your job is to search
and analyze codebases efficiently.

## Focus Areas
- Finding relevant files and functions
- Understanding code structure and patterns
- Providing clear, concise summaries
```

### Frontmatter Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | Yes | Short description of the agent's purpose |
| `model` | string | No | Model to use (inherits from session if omitted) |
| `allowed-tools` | string[] | No | Whitelist of tools (supports wildcards like `mcp__github__*`) |
| `denied-tools` | string[] | No | Blacklist of tools |
| `skills` | string[] | No | Allowed skill names |
| `max-iterations` | object | No | Max iterations per thoroughness level |
| `default-thoroughness` | string | No | Default thoroughness (`quick`, `medium`, `very_thorough`) |
| `shared-context` | string[] | No | Shared context access: `[read]`, `[write]`, or `[read, write]` |
| `variables` | object | No | Default variable values for `$VARIABLE` substitution in prompt |
| `hooks` | object | No | Lifecycle hooks (PreToolUse, PostToolUse, Stop) |
| `retry` | object | No | Retry config: `maxRetries`, `initialDelay` |

### Variable Substitution

The system prompt body supports `$VARIABLE` substitution:

| Variable | Description |
|----------|-------------|
| `$TASK` | The task description passed to the agent |
| `$MAX_ITERATIONS` | Resolved max iterations for the chosen thoroughness |
| `$THOROUGHNESS` | The thoroughness level name |
| Custom variables | Any key defined in `variables` frontmatter or passed at spawn time |

## Foreground vs Background Execution

### Foreground (Default)

The main agent waits for the subagent to complete before continuing:

```
You: Find all components using React hooks
→ Main agent delegates to explore agent
→ Explore agent searches codebase (blocks main agent)
→ Summary returned to main agent
→ Main agent continues
```

### Background

The subagent runs concurrently while the main agent continues:

```
You: In the background, search for all TODO comments
→ Background agent starts
→ Main agent continues immediately
→ [notification appears when background agent finishes]
```

Background agents are managed by the `BackgroundAgentManager`:
- **Concurrency limit**: Up to 4 background agents run simultaneously
- **Queuing**: Excess spawns are queued and start as slots open
- **Turn grouping**: Agents spawned in the same turn get consolidated notifications
- **Cancellation**: Running or queued agents can be cancelled

## Thoroughness Levels

| Level | Use Case | Example |
|-------|----------|---------|
| `quick` | Simple lookups, known locations | "Find the User model" |
| `medium` | Standard exploration and analysis | "Explore the auth system" |
| `very_thorough` | Comprehensive analysis, large codebases | "Do a thorough security review" |

The main agent automatically selects thoroughness based on the task complexity, or you can request it explicitly: *"Do a very thorough review of the payment code."*

## Security

Certain tools are always denied for agents to prevent dangerous patterns:

- `agent_delegate` — No agent chaining (agents cannot spawn agents)
- `create_dynamic_agent` — No recursive agent creation
- `coordinate_task` — No recursive coordination loops

## Best Practices

### Let the Main Agent Decide

The main agent automatically delegates to the right agent type. You don't need to specify — just describe your task naturally:

```
# These all trigger the right agent automatically:
"Find where user authentication is handled"     → explore
"Review the payment code for security issues"   → review
"Break down the steps to add OAuth support"     → plan
```

### Be Specific in Requests

More specific tasks produce better results:

```
# Less effective:
"Look at the code"

# More effective:
"Find all API route handlers that don't validate input parameters"
```

### Use Background for Independent Tasks

When you have work that doesn't block your next step:

```
"In the background, do a thorough review of the error handling patterns"
```
