---
title: Tools Reference
description: Built-in tools available to the B4M CLI agent
sidebar_position: 5
---

# Tools Reference

The B4M CLI agent has access to various tools for file operations, code search, web access, and more. Tools are categorized by their permission requirements.

## Tool Categories

### Auto-Approve (Always Safe)

These tools run automatically without permission prompts:

| Tool | Description |
|------|-------------|
| `math_evaluate` | Evaluate mathematical expressions |
| `current_datetime` | Get current date and time |
| `dice_roll` | Roll dice (for fun/games) |
| `prompt_enhancement` | Enhance prompts |

### Prompt Default (Can Be Trusted)

These tools prompt for permission by default but can be trusted:

| Tool | Description |
|------|-------------|
| `file_read` | Read file contents |
| `grep_search` | Search file contents with regex |
| `glob_files` | Find files by pattern |
| `get_file_tree` | Get directory structure |
| `web_search` | Search the web |
| `deep_research` | In-depth web research |
| `weather_info` | Get weather data |
| `git_status` | Git repository status |
| `git_diff` | Show git differences |
| `git_log` | Show commit history |
| `git_branch` | List/manage branches |

### Prompt Always (Cannot Be Trusted)

These tools always require permission due to their destructive potential:

| Tool | Description |
|------|-------------|
| `create_file` | Create or overwrite files |
| `edit_file` | Edit existing files |
| `delete_file` | Delete files |
| `bash_execute` | Execute shell commands |
| `shell_execute` | Execute shell commands |
| `git_commit` | Create git commits |
| `git_push` | Push to remote |

## File Operations

### file_read

Read the contents of a file.

**Parameters**:
- `path` (string): Relative path to the file

**Security**:
- Path must be within current working directory
- Symlinks outside cwd are blocked
- Binary files return an error
- Maximum file size: 1MB

**Example prompt**:
```
Read the contents of src/index.ts
```

### create_file

Create a new file or overwrite an existing one.

**Parameters**:
- `path` (string): Relative path for the file
- `content` (string): File contents

**Permission Preview**:
Shows the file path and diff (for overwrites).

**Example prompt**:
```
Create a new file utils/helpers.ts with a sum function
```

### edit_file

Edit an existing file using search/replace.

**Parameters**:
- `path` (string): File to edit
- `search` (string): Text to find
- `replace` (string): Replacement text

**Example prompt**:
```
In src/config.ts, change the port from 3000 to 8080
```

### delete_file

Delete a file.

**Parameters**:
- `path` (string): File to delete

**Example prompt**:
```
Delete the old config.bak file
```

## Code Search

### grep_search

Search file contents using regular expressions.

**Parameters**:
- `pattern` (string): Regex pattern to search
- `path` (string, optional): Directory or file to search
- `include` (string, optional): File pattern to include
- `exclude` (string, optional): File pattern to exclude

**Example prompts**:
```
Find all uses of useState in the src directory

Search for TODO comments in TypeScript files
```

### glob_files

Find files matching a glob pattern.

**Parameters**:
- `pattern` (string): Glob pattern (e.g., `**/*.ts`)
- `cwd` (string, optional): Starting directory

**Example prompts**:
```
Find all TypeScript files in the project

List all package.json files
```

### get_file_tree

Get the directory structure.

**Parameters**:
- `path` (string, optional): Root directory
- `depth` (number, optional): Maximum depth

**Example prompt**:
```
Show me the directory structure of src/
```

## Shell Commands

### bash_execute

Execute a shell command.

**Parameters**:
- `command` (string): Command to execute
- `cwd` (string, optional): Working directory
- `timeout` (number, optional): Timeout in milliseconds

**Security**:
- Always requires permission
- Shows the exact command before execution
- Output is captured and returned

**Example prompts**:
```
Run npm test

Check the git status

List all running processes
```

**Direct Usage**:
You can also use the `!` prefix:
```
!npm test
!git status
```

## Web Tools

### web_search

Search the web using Serper API.

**Parameters**:
- `query` (string): Search query
- `num` (number, optional): Number of results

**Note**: Server-side tool using Bike4Mind API keys.

**Example prompt**:
```
Search for React 19 new features
```

### weather_info

Get current weather for a location.

**Parameters**:
- `location` (string): City name or coordinates

**Note**: Server-side tool using Bike4Mind API keys.

**Example prompt**:
```
What&apos;s the weather in Tokyo?
```

## Git Tools

### git_status

Show the working tree status.

**Example prompt**:
```
What files have I changed?
```

### git_diff

Show changes between commits, commit and working tree, etc.

**Parameters**:
- `ref` (string, optional): Commit or branch to compare
- `staged` (boolean, optional): Show staged changes

**Example prompt**:
```
Show me what changes are staged for commit
```

### git_log

Show commit logs.

**Parameters**:
- `count` (number, optional): Number of commits
- `branch` (string, optional): Branch to show

**Example prompt**:
```
Show the last 5 commits on main
```

### git_commit

Create a new commit.

**Parameters**:
- `message` (string): Commit message
- `files` (string[], optional): Files to commit (default: all staged)

**Example prompt**:
```
Commit my changes with message &quot;Fix authentication bug&quot;
```

### git_push

Push commits to remote.

**Parameters**:
- `remote` (string, optional): Remote name (default: origin)
- `branch` (string, optional): Branch to push

**Example prompt**:
```
Push my changes to origin
```

## Utility Tools

### math_evaluate

Evaluate mathematical expressions.

**Parameters**:
- `expression` (string): Math expression

**Example prompts**:
```
Calculate 15% of 1250

What&apos;s the square root of 144?
```

### current_datetime

Get the current date and time.

**Parameters**: None

**Example prompt**:
```
What time is it?
```

## Permission System

### How Permissions Work

When a tool requires permission, you see:

```
🛡️ Permission Required

Tool: create_file
Path: src/newfile.ts

Preview:
+ export function helper() {
+   return &quot;Hello&quot;;
+ }

[A]llow  [D]eny  [T]rust for session
```

**Options**:
- **Allow (A)**: Execute this once
- **Deny (D)**: Block this execution
- **Trust (T)**: Allow this tool for the session

### Trusting Tools

For tools you use frequently:

```
/trust file_read
/trust grep_search
```

Choose where to save:
- **Local**: This project, gitignored
- **Project**: Team-shared, committed
- **Global**: All projects

### Viewing Trusted Tools

```
/trusted
```

### Denying Tools

Project admins can deny tools in `.bike4mind/config.json`:

```json
{
  "tools": {
    "denied": ["delete_file", "git_push"]
  }
}
```

Denied tools cannot be trusted or used.

## Server-Side Tools

Some tools run on the Bike4Mind server using company API keys:

- `web_search` - Uses Serper API
- `weather_info` - Uses OpenWeather API

This means:
- No API key configuration needed
- Usage is tracked in your credits
- Tools work immediately after authentication

## Tool Tips

### Efficient File Reading

Instead of reading many files one by one:
```
Read all files in src/components/
```

Use glob and targeted reads:
```
Find React components using hooks, then read the relevant ones
```

### Batch Operations

The agent can chain tools:
```
Find all TODO comments, create a summary, and save it to TODO.md
```

### Security Best Practices

1. Review permission previews carefully
2. Trust read-only tools to speed up exploration
3. Never trust destructive tools globally
4. Use project config to enforce team policies
