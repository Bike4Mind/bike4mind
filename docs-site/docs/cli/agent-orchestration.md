---
title: Agent Orchestration
description: Coordinate complex tasks with DAG-based multi-agent pipelines
sidebar_position: 8
---

# Agent Orchestration

For complex tasks that involve multiple steps with dependencies, the B4M CLI can automatically decompose work into a pipeline of specialized agents that execute in the optimal order — with independent tasks running in parallel.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  1. You describe a complex task                         │
│     "Refactor the auth system and add tests"            │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  2. Coordinator agent analyzes and decomposes           │
│     → explore-auth (explore)                            │
│     → explore-tests (explore)     ← parallel            │
│     → plan-refactor (plan)        ← depends on explores │
│     → implement (general-purpose) ← depends on plan     │
│     → review (review)             ← depends on implement│
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  3. DAG scheduler executes the pipeline                 │
│     Level 0: explore-auth + explore-tests (parallel)    │
│     Level 1: plan-refactor (waits for both explores)    │
│     Level 2: implement (waits for plan)                 │
│     Level 3: review (waits for implement)               │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  4. Results synthesized into a coherent response        │
└─────────────────────────────────────────────────────────┘
```

## Using Coordinator Mode

The main agent uses coordinator mode automatically for complex multi-step tasks. You can also trigger it explicitly:

```
Coordinate this task: explore the authentication system,
plan a refactor to use JWT tokens, implement the changes,
and review the result
```

Or simply describe a complex task naturally:

```
Refactor the user service to use dependency injection,
add proper error handling, and write tests for it
```

### When Coordinator Mode Activates

The main agent uses `coordinate_task` when it determines a task would benefit from structured decomposition — typically when the request involves:

- Multiple distinct phases (explore, plan, implement, review)
- Tasks that can be parallelized (searching multiple areas simultaneously)
- Complex workflows with clear dependencies

### When It Does NOT Activate

Simple, single-step tasks bypass the coordinator entirely:

```
# These use direct delegation (no coordinator overhead):
"Find where the User model is defined"
"Fix the typo in the login button"
```

## Task Decomposition

The coordinator agent uses a **tool-based decomposition** approach — it calls a `decompose_task` tool that produces structured, Zod-validated output. This is far more reliable than parsing JSON from free text.

### Agent Types for Subtasks

| Type | Access | Use For |
|------|--------|---------|
| `explore` | Read-only | Finding files, understanding patterns, searching code |
| `plan` | Read-only | Designing solutions, breaking down sub-problems |
| `general-purpose` | Full access | Writing code, creating files, editing, running commands |
| `review` | Read-only | Code quality analysis, finding bugs, checking patterns |
| `test` | Execute + read | Running tests, verifying behavior |

### Dependency Ordering

The coordinator specifies dependencies between tasks. The DAG scheduler resolves these into execution levels:

- **Independent tasks** at the same level run in parallel
- **Dependent tasks** wait for their prerequisites to complete
- **Results flow forward** — each task receives the output of its dependencies as context

## Shared Context

Agents in a pipeline can share discoveries through a **shared context store** — a namespaced key-value system that eliminates redundant re-exploration.

### How It Works

When an explore agent discovers important file paths or patterns, it can write them to shared context. Later agents in the pipeline can read these findings instead of searching again.

```
explore-auth agent:
  → Finds auth files at src/auth/*.ts
  → Writes to shared context: { "auth-files": "src/auth/login.ts, src/auth/session.ts, ..." }

implement agent:
  → Reads shared context: gets file paths directly
  → Skips re-exploration, starts implementing immediately
```

### Constraints

| Constraint | Value | Purpose |
|------------|-------|---------|
| Max entries per namespace | 50 | Prevents unbounded growth |
| Max value length | 2,000 chars | Keeps context concise |
| TTL | 30 minutes | Auto-cleanup of stale data |

### Agent Access Control

Agents declare their shared context access in frontmatter:

```yaml
shared-context:
  - read    # Can read entries from other agents
  - write   # Can write entries for other agents
```

All built-in pipeline agents (`explore`, `plan`, `general-purpose`, `review`, `test`) have both read and write access. The shared context tools (`shared_context_read`, `shared_context_write`) are only injected when the agent runs inside a coordinated pipeline — they do not appear for direct agent delegation.

## Cascade Failure

If a task in the pipeline fails, the scheduler intelligently handles it:

- **Failed task**: Marked as `failed` with the error message
- **Dependent tasks**: Marked as `cascade_failed` with an explanation of which dependency blocked them
- **Independent tasks**: Continue executing normally

```
Example: explore-auth fails

Level 0: explore-auth (FAILED) | explore-tests (COMPLETED)
Level 1: plan-refactor (CASCADE_FAILED - blocked by explore-auth)
Level 2: implement (CASCADE_FAILED - blocked by plan-refactor)
Level 3: test-results (COMPLETED - only depended on explore-tests)
```

This means a failure in one branch doesn't stop unrelated work in other branches.

## Example Walkthrough

### Input

```
Coordinate this task: Add input validation to the signup form
with proper error messages, then review the implementation
```

### Coordinator Decomposition

The coordinator agent explores the codebase, then calls `decompose_task`:

```
1. explore-signup     → Find signup form components and current validation
   Agent: explore     | Depends on: (none)

2. explore-patterns   → Find how validation is done elsewhere in the codebase
   Agent: explore     | Depends on: (none)

3. implement          → Add validation logic to the signup form
   Agent: general-purpose | Depends on: explore-signup, explore-patterns

4. review             → Review the validation implementation
   Agent: review      | Depends on: implement
```

### Execution

```
Level 0: explore-signup + explore-patterns (run in parallel)
Level 1: implement (runs after both explores complete, receives their findings)
Level 2: review (runs after implementation, analyzes the changes)
```

### Output

The final response includes a structured summary with results from each task, completion status, and any errors encountered.

## Limitations

- **No agent chaining**: Subtask agents cannot spawn their own subagents
- **No cross-pipeline context**: Each `coordinate_task` invocation gets a fresh shared context
- **Coordinator overhead**: Adds one extra agent call for decomposition — not worth it for simple tasks (the system automatically skips the pipeline for single-task decompositions)
- **Token cost**: Each subtask agent consumes its own token budget
