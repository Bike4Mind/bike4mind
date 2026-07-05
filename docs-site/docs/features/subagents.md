---
title: Subagents
description: Specialized AI agents for focused tasks like code exploration, planning, and review
sidebar_position: 8
tags: [agents, subagents, automation, tasks]
---

# Subagents

Subagents are specialized AI instances that handle focused tasks in isolated contexts, keeping your main conversation clean while providing faster, more targeted results.

## Overview

The B4M CLI supports three types of subagents:

- **Explore**: Fast, read-only codebase exploration and search
- **Plan**: Task breakdown and planning
- **Review**: Code quality analysis and review

## Why Use Subagents?

### Performance
- Uses optimized models (Haiku for explore/plan, Sonnet for review)
- Faster execution for focused tasks
- Reduced latency for searches

### Context Management
- Keeps main conversation focused and clean
- Prevents context pollution from verbose exploration
- Isolated execution with summarized results

### Cost Efficiency
- Smaller, faster models for appropriate tasks
- Separate token tracking
- More efficient than using main agent for everything

## Using Subagents

### The `subagent_delegate` Tool

The main agent can delegate tasks to subagents using the `subagent_delegate` tool:

```json
{
  "task": "Find all files that handle authentication",
  "type": "explore",
  "thoroughness": "medium"
}
```

### Thoroughness Levels

Each subagent execution can be configured with a thoroughness level:

- **quick**: Fast lookup, 1-2 iterations
- **medium**: Balanced exploration, 3-5 iterations (default)
- **very_thorough**: Comprehensive analysis, 8-10 iterations

## Subagent Types

### Explore Subagent

Optimized for codebase exploration and search.

**Model**: `claude-3-5-haiku-20241022` (fast)

**Tools**:
- `file_read` - Read file contents
- `grep_search` - Search code patterns
- `glob_files` - Find files by pattern
- `bash_execute` - Read-only shell commands
- `current_datetime` - Get current time
- `math_evaluate` - Mathematical calculations

**Use Cases**:
- Finding files by name or pattern
- Searching for code patterns
- Understanding code structure
- Locating specific functions or components

**Example**:
```bash
# User: "Where are errors from the client handled?"
# Agent delegates to Explore subagent
# Subagent searches codebase and returns summary
```

### Plan Subagent

Optimized for breaking down complex tasks into actionable steps.

**Model**: `claude-3-5-haiku-20241022` (fast)

**Tools**: Same as Explore subagent

**Use Cases**:
- Breaking down feature implementations
- Creating task sequences
- Identifying dependencies
- Estimating scope

**Example**:
```bash
# User: "Help me plan implementing a new authentication system"
# Agent delegates to Plan subagent
# Subagent analyzes codebase and returns structured plan
```

### Review Subagent

Optimized for code quality analysis.

**Model**: `claude-3-5-sonnet-20241022` (better reasoning)

**Tools**: Read-only tools (file_read, grep_search, glob_files, bash_execute)

**Use Cases**:
- Code quality analysis
- Bug identification
- Security review
- Performance analysis

**Example**:
```bash
# User: "Review the authentication module for security issues"
# Agent delegates to Review subagent
# Subagent analyzes code and returns findings
```

## Configuration

### Default Configuration

Subagents come with sensible defaults. No configuration required to start using them.

### Custom Configuration

You can customize subagent behavior in your config files:

#### Global Config (`~/.bike4mind/config.json`)

```json
{
  "subagents": {
    "explore": {
      "model": "claude-3-5-haiku-20241022",
      "maxIterations": {
        "quick": 2,
        "medium": 5,
        "very_thorough": 10
      },
      "defaultThoroughness": "medium"
    }
  }
}
```

#### Project Config (`.bike4mind/config.json`)

```json
{
  "subagents": {
    "explore": {
      "systemPrompt": "Custom prompt for this project...",
      "allowedTools": ["file_read", "grep_search", "glob_files"],
      "deniedTools": ["bash_execute"]
    }
  }
}
```

### Configuration Options

```typescript
{
  "type": "explore" | "plan" | "review",
  "model": string,              // Model ID to use
  "systemPrompt": string,       // Custom system prompt
  "allowedTools": string[],     // Whitelist of tools
  "deniedTools": string[],      // Blacklist of tools
  "maxIterations": {
    "quick": number,
    "medium": number,
    "very_thorough": number
  },
  "defaultThoroughness": "quick" | "medium" | "very_thorough"
}
```

## Claude Code Compatibility

B4M subagents are designed to be compatible with Claude Code's agent system.

### Tool Name Mapping

Both Claude Code and B4M tool names are supported:

| Claude Code | B4M | Description |
|-------------|-----|-------------|
| `read` | `file_read` | Read file contents |
| `write` | `create_file` | Create/update file |
| `edit` | `edit_file` | Edit file |
| `delete` | `delete_file` | Delete file |
| `glob` | `glob_files` | Find files by pattern |
| `grep` | `grep_search` | Search code |
| `bash` | `bash_execute` | Execute shell command |

### Config Format

Both `.bike4mind/config.json` and `.claude/config.json` formats are supported.

**B4M Format**:
```json
{
  "subagents": {
    "explore": {
      "allowedTools": ["file_read", "grep_search"]
    }
  }
}
```

**Claude Code Format** (also supported):
```json
{
  "agents": {
    "explore": {
      "tools": {
        "allowed": ["read", "grep"]
      }
    }
  }
}
```

## Best Practices

### When to Use Subagents

✅ **Use subagents for:**
- Extensive codebase searches
- Code structure analysis
- Task planning and breakdown
- Code quality reviews
- When you need focused, isolated work

❌ **Don't use subagents for:**
- Simple file reads (use direct tools)
- Writing or modifying files (subagents are read-only)
- Interactive workflows (subagents run independently)
- When you need the context of the main conversation

### Thoroughness Guidelines

- **quick**: Single file lookup, simple search
- **medium**: Multi-file exploration, moderate complexity (default)
- **very_thorough**: Comprehensive analysis, complex patterns

### Performance Tips

1. Use **explore** subagent for searches (faster Haiku model)
2. Use **review** subagent for analysis (better reasoning with Sonnet)
3. Specify **quick** thoroughness for simple lookups
4. Let the agent decide when delegation makes sense

## Monitoring

### Token Usage

Subagent token usage is tracked separately in session metadata:

```typescript
{
  metadata: {
    totalTokens: 5000,        // Main agent tokens
    subagentCalls: 3,         // Number of subagent calls
    subagentTokens: 1200,     // Tokens used by subagents
    subagentCost: 0.0024      // Cost of subagent calls
  }
}
```

### Debugging

Enable debug logging to see subagent execution:

```bash
export B4M_VERBOSE=1
b4m
```

Look for log entries like:
```
Spawning explore subagent with 6 tools, thoroughness: medium
Subagent completed in 2341ms, 4 iterations, 856 tokens
```

## Examples

### Example 1: Finding Authentication Code

```bash
User: "Find all files related to authentication"

# Agent automatically delegates to Explore subagent
# Explore subagent searches codebase
# Returns summary: "Found 8 files related to authentication:
#   - src/auth/AuthProvider.ts
#   - src/auth/useAuth.ts
#   - src/middleware/auth.ts
#   ..."
```

### Example 2: Planning a Feature

```bash
User: "Help me plan implementing a dark mode feature"

# Agent delegates to Plan subagent
# Plan subagent analyzes codebase structure
# Returns structured plan with milestones and dependencies
```

### Example 3: Code Review

```bash
User: "Review the API endpoints for security issues"

# Agent delegates to Review subagent
# Review subagent analyzes API code
# Returns findings with specific file/line references
```

## Troubleshooting

### Subagent Not Available

If you see "No configuration found for subagent type", check:
- Subagent type is valid: `explore`, `plan`, or `review`
- Configuration is properly formatted
- Config file is in the correct location

### Tool Access Issues

If subagent can't access tools:
- Check `allowedTools` and `deniedTools` in config
- Verify tool names are correct (both Claude Code and B4M formats supported)
- Check project-level tool restrictions (`.bike4mind/config.json`)

### Performance Issues

If subagent is too slow:
- Use `quick` thoroughness for simple tasks
- Check iteration limits in configuration
- Verify network connectivity (model API calls)

## Future Enhancements

Planned features for subagents:

- Custom subagent types via configuration
- Subagent chaining (one subagent calling another)
- Parallel subagent execution
- Subagent result caching
- More fine-grained tool control

## Related Features

- [Agents](./agents.md) - Custom AI assistants
- [Quest Master](./quest-master.md) - Autonomous task planning
- [Research Mode](./research-mode.md) - Compare multiple models side-by-side
- [Notebooks](./notebooks.md) - Where subagents execute tasks
