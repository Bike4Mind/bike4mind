---
title: Advanced Usage
description: Best practices and advanced techniques for B4M CLI
sidebar_position: 9
---

# Advanced Usage

Advanced techniques and best practices for power users.

## Workflow Optimization

### Context File Strategies

#### Project-Specific Instructions

Create targeted instructions for different project types:

**Web App (`CLAUDE.md`):**
```markdown
# Full-Stack Web App Guidelines

## Tech Stack
- Next.js 13+ with App Router
- TypeScript strict mode
- Prisma ORM with PostgreSQL
- Tailwind CSS for styling

## Conventions
- Server Components by default
- Client Components only when needed
- API routes in app/api/
- Use Server Actions for mutations

## Before Committing
- Run `pnpm typecheck`
- Run `pnpm test`
- Run `pnpm lint`
```

**CLI Tool (`CLAUDE.md`):**
```markdown
# CLI Tool Development Guidelines

## Tech Stack
- Node.js 18+ (ESM)
- TypeScript
- Commander.js for CLI
- Chalk for colors

## Conventions
- Keep bundle size small
- Use `#!/usr/bin/env node` shebang
- Handle SIGINT gracefully
- Provide --help for all commands

## Testing
- Test on macOS, Linux, Windows
- Mock external APIs
- Test error scenarios
```

---

#### Layer Context Files

Use multiple context layers for different purposes:

**Global preferences (`~/.bike4mind/AI.md`):**
```markdown
# My AI Assistant Preferences

- Always explain your reasoning
- Provide examples for complex concepts
- Suggest optimizations proactively
- Ask clarifying questions when unclear
```

**Project standards (`CLAUDE.md`):**
```markdown
# Project Code Standards

- TypeScript strict mode required
- 100% test coverage for critical paths
- Comprehensive error handling
```

**Personal overrides (`CLAUDE.local.md`, gitignored):**
```markdown
# My Personal Preferences for This Project

- Use tabs not spaces (team uses spaces, but I prefer tabs)
- Verbose comments (team prefers minimal)
```

---

### Prompt Engineering

#### Effective Prompts

**❌ Vague:**
```bash
> Help with testing
```

**✅ Specific:**
```bash
> Create a comprehensive test suite for the UserService class including:
> 1. Unit tests for all public methods
> 2. Mock the database layer
> 3. Test error scenarios
> 4. Use Jest with TypeScript
```

---

#### Multi-Step Workflows

Break complex tasks into phases:

```bash
> Phase 1: Analyze the current authentication system
[Agent analyzes...]

> Phase 2: Design improvements for security
[Agent designs...]

> Phase 3: Implement the security improvements
[Agent implements...]

> Phase 4: Create tests for the new auth flow
[Agent creates tests...]

> Phase 5: Update documentation
[Agent updates docs...]

# Save progress
/save auth-security-upgrade
```

---

#### Template Prompts

Create reusable prompt patterns:

**Code Review Template:**
```bash
> Review [FILE] for:
> - Code quality and readability
> - Potential bugs
> - Performance issues
> - Security vulnerabilities
> - Best practice violations
> Provide specific line numbers and improvement suggestions.
```

**Test Generation Template:**
```bash
> Generate comprehensive tests for [FILE]:
> - Test all public methods
> - Cover edge cases
> - Mock external dependencies
> - Use [TEST_FRAMEWORK]
> - Aim for 100% coverage
```

**Documentation Template:**
```bash
> Create API documentation for [FILE]:
> - Overview and purpose
> - All endpoints/functions
> - Request/response formats
> - Examples for each
> - Error handling
```

---

## Tool Mastery

### Tool Chaining

Combine tools for complex workflows:

```bash
> Find all TypeScript files with TODO comments, extract them,
> organize by priority, and create GitHub issues for high-priority ones

[Agent chains tools:]
1. bash_execute: find . -name "*.ts"
2. bash_execute: grep -n "TODO" [files]
3. [Analyzes and organizes]
4. github__create_issue (via MCP) for each high-priority item

[Results with issue links]
```

---

### Tool Permissions Management

#### Tiered Trust System

**Always trust (safe, read-only):**
```bash
/trust dice_roll
/trust math_evaluate
/trust current_datetime
```

**Conditional trust (case-by-case):**
- Review each execution for:
  - `bash_execute`
  - MCP tools with write access
  - External API calls

**Never trust (always review):**
- Custom tools from unknown sources
- Tools that modify system state
- Tools with security implications

---

#### Per-Project Trust

Different trust levels for different projects:

**Development Project:**
```bash
# Trust common dev tools
/trust bash_execute
/trust web_search
```

**Production Environment:**
```bash
# Untrust destructive tools
/untrust bash_execute

# Review every command
```

---

### Custom Tool Workflows

#### Bash Command Patterns

**Find and Replace:**
```bash
> Use bash to find all occurrences of "oldFunction" and replace with "newFunction"

[tool: bash_execute]
find . -name "*.ts" -exec sed -i '' 's/oldFunction/newFunction/g' {} \;
```

**Project Statistics:**
```bash
> Get project statistics

[Chains multiple commands:]
- Line count: wc -l $(find . -name "*.ts")
- File count: find . -name "*.ts" | wc -l
- Test coverage: npm test -- --coverage
- Dependencies: npm ls --depth=0
```

---

## Session Management Best Practices

### Naming Conventions

Use descriptive, searchable names:

**Good names:**
```bash
/save 2025-01-14-typescript-migration
/save feat-user-auth-implementation
/save bug-investigation-memory-leak
/save research-react-19-features
```

**Poor names:**
```bash
/save session1
/save test
/save abc
/save work
```

---

### Session Organization

#### By Project:
```bash
/save projectname-feature-description
/save myapp-authentication-upgrade
/save website-performance-optimization
```

#### By Date:
```bash
/save 2025-01-14-code-review
/save 2025-01-15-bug-fixes
```

#### By Type:
```bash
/save research-kubernetes-best-practices
/save implementation-user-dashboard
/save debug-memory-leak-investigation
```

---

### Session Rotation

Prevent sessions from becoming too large:

**Rule of thumb:**
- Save after ~50 messages
- Start fresh session for new topics
- Reference old sessions if needed

**Example workflow:**
```bash
# After 45 messages working on auth
/save auth-implementation-part1

# Start fresh for next phase
/exit
b4m

> Continue auth work (refer to previous session if needed)
# After another 50 messages
/save auth-implementation-part2
```

---

## MCP Integration Patterns

### Multi-Server Workflows

Combine multiple MCP servers:

```bash
> Check if there are any GitHub issues related to our Jira sprint items

[Uses both GitHub and Atlassian MCP:]
1. atlassian__get_sprint_issues
2. For each Jira issue:
   - Extract keywords
   - github__search_issues with keywords
3. Match and report correlations
```

---

### Conditional Server Usage

Enable servers only when needed:

**Default (all disabled):**
```json
{
  "mcpServers": [
    {"name": "github", "enabled": false, "env": {...}},
    {"name": "atlassian", "enabled": false, "env": {...}}
  ]
}
```

**Enable for specific project:**
```bash
# Manually edit config before starting work
nano ~/.bike4mind/config.json
# Set github: enabled: true

b4m
# Work on GitHub-related tasks

# Disable after
nano ~/.bike4mind/config.json
# Set github: enabled: false
```

---

### Custom MCP Server Development

Build project-specific MCP servers:

**Example: Database Query Server**

```javascript
// db-mcp-server.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pg from 'pg';

const server = new Server({
  name: 'database-server',
  version: '1.0.0',
});

// Connect to database
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL
});
await client.connect();

// Register read-only query tool
server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'db_query',
    description: 'Execute read-only SQL query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }
      },
      required: ['query']
    }
  }]
}));

server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name === 'db_query') {
    // Safety: only allow SELECT
    const query = request.params.arguments.query;
    if (!query.trim().toLowerCase().startsWith('select')) {
      throw new Error('Only SELECT queries allowed');
    }

    const result = await client.query(query);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result.rows, null, 2)
      }]
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Configuration:**
```json
{
  "mcpServers": [
    {
      "name": "database",
      "command": "node",
      "args": ["/path/to/db-mcp-server.js"],
      "env": {
        "DATABASE_URL": "postgresql://..."
      },
      "enabled": true
    }
  ]
}
```

---

## Performance Optimization

### Reduce Context Size

**Keep context files small:**
```bash
# Check size
wc -c CLAUDE.md
# Keep under 10KB (10,000 bytes)

# If too large, split into focused sections
mv CLAUDE.md CLAUDE-full.md
cat CLAUDE-full.md | head -200 > CLAUDE.md
```

---

### Minimize Tool Calls

**❌ Inefficient:**
```bash
> List all files
[tool: bash_execute] ls
> Count TypeScript files
[tool: bash_execute] find . -name "*.ts" | wc -l
> Count JavaScript files
[tool: bash_execute] find . -name "*.js" | wc -l
```

**✅ Efficient:**
```bash
> Get project statistics: total files, TypeScript count, JavaScript count

[Single compound command:]
[tool: bash_execute]
echo "Total: $(ls -1 | wc -l)"
echo "TypeScript: $(find . -name '*.ts' | wc -l)"
echo "JavaScript: $(find . -name '*.js' | wc -l)"
```

---

### Session Cleanup

Regularly clean up old data:

```bash
# Clean old sessions (keep last 10)
cd ~/.bike4mind/sessions
ls -t | tail -n +11 | xargs rm

# Clean old debug logs (auto-cleaned after 30 days)
# Manual cleanup:
find ~/.bike4mind/debug -type f -mtime +7 -delete
```

---

## Security Best Practices

### API Key Management

**❌ Don't:**
```json
{
  "toolApiKeys": {
    "serper": "plaintext-key-in-config"
  }
}
```

**✅ Do:**
```bash
# Use environment variables
export SERPER_API_KEY="..."
b4m
```

**✅ Even better:**
```bash
# Use a secrets manager
export SERPER_API_KEY=$(security find-generic-password -w -s serper)
b4m
```

---

### Audit Tool Usage

Review what tools can do:

```bash
# Check trusted tools regularly
/trusted

# Review tool activity in logs
grep "TOOL_CALL" ~/.bike4mind/debug/*.txt | tail -20
```

---

### Sandbox Testing

Test destructive commands safely:

```bash
# Create temp directory
cd $(mktemp -d)

# Test commands here
> Test this bash command: rm *.txt

# Review before running in real project
```

---

## Automation & Scripting

### Wrapper Scripts

Create helper scripts for common workflows:

**`~/bin/b4m-review`:**
```bash
#!/bin/bash
# Quick code review helper

cd "$1" || exit 1
b4m << 'EOF'
Review all uncommitted changes:
1. Run git diff
2. Analyze changes for:
   - Code quality
   - Potential bugs
   - Security issues
3. Provide specific feedback with line numbers
4. Suggest improvements
EOF
```

Usage:
```bash
chmod +x ~/bin/b4m-review
b4m-review /path/to/project
```

---

### Batch Processing

Process multiple items:

**Process all TODO comments:**
```bash
> Find all TODO comments, categorize them, estimate effort,
> and create a prioritized task list

[Agent processes all TODOs and creates organized list]

/save todo-analysis-2025-01-14
```

---

## Integration Patterns

### IDE Integration

Use B4M CLI alongside your IDE:

**Terminal split workflow:**
```
┌──────────────────────┬──────────────────────┐
│                      │                      │
│   Editor (VS Code)   │    B4M CLI          │
│                      │                      │
│   [code]             │  > Explain this...  │
│   [code]             │                      │
│   [code]             │  [agent response]   │
│                      │                      │
└──────────────────────┴──────────────────────┘
```

---

### Git Workflow Integration

**Pre-commit hook:**
```bash
#!/bin/bash
# .git/hooks/pre-commit

echo "Running B4M CLI code review..."
b4m --verbose << 'EOF'
Review git diff --cached
Check for:
- Syntax errors
- Potential bugs
- Security issues
Print: "PASS" or "FAIL: [reason]"
EOF
```

---

## Advanced Context Management

### Dynamic Context

Adjust instructions based on task:

**Research mode:**
```bash
> I'm in research mode. Prioritize:
> - Comprehensive information
> - Citations and sources
> - Multiple perspectives
> - Detailed explanations
```

**Quick-answer mode:**
```bash
> I'm in quick-answer mode. Prioritize:
> - Concise responses
> - Direct answers
> - Minimal explanation
> - Fast tool execution
```

---

### Context Inheritance

Build on previous context:

```bash
# Session 1: Planning
> Plan the authentication system
/save auth-plan

# Session 2: Implementation (references plan)
> Implement the authentication plan from auth-plan session
/save auth-implementation

# Session 3: Testing (references implementation)
> Create tests based on auth-implementation
/save auth-tests
```

---

## Debugging Techniques

### Verbose Analysis

```bash
b4m --verbose

# Watch logs in real-time (separate terminal)
tail -f ~/.bike4mind/debug/*.txt
```

---

### Isolate Issues

**Test incrementally:**
```bash
# Step 1: Test basic functionality
> Simple test: 1+1

# Step 2: Test tool execution
> Run: echo "test"

# Step 3: Test MCP integration
> List GitHub repos

# Identify where issue occurs
```

---

### Log Analysis

```bash
# Find errors
grep -i error ~/.bike4mind/debug/*.txt

# Find specific tool calls
grep "TOOL_CALL.*bash_execute" ~/.bike4mind/debug/*.txt

# Analyze request sizes
grep "HTTP_REQUEST" ~/.bike4mind/debug/*.txt | grep "Size:"
```

---

## See Also

- [Features Guide →](/cli/features) - Detailed feature documentation
- [Configuration →](/cli/configuration) - Configuration options
- [MCP Integration →](/cli/mcp-integration) - Custom MCP servers
- [Examples →](/cli/examples) - Real-world examples
- [Troubleshooting →](/cli/troubleshooting) - Common issues
