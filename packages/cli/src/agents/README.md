# Subagent System

This directory contains the subagent orchestration system for the B4M CLI.

## Architecture

The subagent system enables specialized AI agents for focused tasks like code exploration, planning, and review. Each subagent runs in an isolated context with restricted tools and optimized models.

### Key Components

```
agents/
├── SubagentOrchestrator.ts  # Core orchestration logic
├── configs.ts               # Default configurations for each subagent type
├── delegateTool.ts          # Tool definition for agent_delegate
└── README.md               # This file
```

### Flow

1. **Main Agent** receives user query
2. **Main Agent** decides to delegate using `agent_delegate` tool
3. **SubagentOrchestrator** spawns appropriate subagent with:
   - Filtered tools (read-only for explore/review)
   - Optimized model (Haiku for speed, Sonnet for reasoning)
   - Isolated context (separate message history)
4. **Subagent** executes task
5. **Orchestrator** summarizes results
6. **Main Agent** receives summary and continues

### Subagent Types

| Type | Model | Tools | Use Case |
|------|-------|-------|----------|
| `explore` | Haiku | Read-only | Fast codebase search |
| `plan` | Haiku | Read-only | Task breakdown |
| `review` | Sonnet | Read-only | Code quality analysis |

### Configuration

Subagents can be configured at three levels:

1. **Default** (`configs.ts`): Built-in sensible defaults
2. **Global** (`~/.bike4mind/config.json`): User preferences
3. **Project** (`.bike4mind/config.json`): Team settings

Example configuration:

```json
{
  "subagents": {
    "explore": {
      "model": "claude-3-5-haiku-20241022",
      "allowedTools": ["file_read", "grep_search", "glob_files"],
      "maxIterations": {
        "quick": 2,
        "medium": 5,
        "very_thorough": 10
      }
    }
  }
}
```

### Tool Filtering

The `toolsAdapter.ts` generates tools with optional filtering:

```typescript
const { tools } = generateCliTools(
  userId,
  llm,
  model,
  permissionManager,
  promptFn,
  agentContext,
  configStore,
  apiClient,
  toolFilter // Optional: { allowedTools, deniedTools }
);
```

### Context Isolation

Each subagent:
- Has its own message history
- Cannot access parent agent's context
- Returns only a summarized result
- Tracks tokens/cost separately

### Adding New Subagent Types

To add a new subagent type:

1. Add type to `SubagentType` enum in `@bike4mind/agents/types.ts`
2. Create configuration in `configs.ts`
3. Update `getDefaultSubagentConfig()` function
4. Update `getDefaultSystemPrompt()` in `SubagentOrchestrator.ts`
5. Update documentation

### Testing

Test subagents by:

1. Using the `agent_delegate` tool in the CLI
2. Checking token usage in session metadata
3. Verifying context isolation (subagent steps not in main conversation)
4. Testing tool filtering (subagents can't access denied tools)

### Performance

Subagent performance targets:

- **Quick** searches: < 5 seconds (p95)
- **Medium** exploration: 10-15 seconds
- **Very thorough** analysis: 20-30 seconds

Monitor via debug logging:

```bash
export B4M_VERBOSE=1
b4m
```

### Claude Code Compatibility

Tool name mapping supports both formats:

- Claude Code: `read`, `write`, `glob`, `grep`, `bash`
- B4M: `file_read`, `create_file`, `glob_files`, `grep_search`, `bash_execute`

Configuration format supports both `.bike4mind/` and `.claude/` directories.

## Related Files

- `packages/cli/src/index.tsx` - Orchestrator initialization
- `packages/cli/src/utils/toolsAdapter.ts` - Tool filtering
- `b4m-core/packages/agents/src/types.ts` - Type definitions
- `packages/cli/src/storage/types.ts` - Config types

## Documentation

See `docs-site/docs/features/subagents.md` for user-facing documentation.
