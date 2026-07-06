---
title: Examples & Tutorials
description: Real-world examples and workflows for B4M CLI
sidebar_position: 7
---

# Examples & Tutorials

Real-world examples showing how to use B4M CLI effectively.

## Development Workflows

### Code Review Assistant

Get help reviewing code changes:

```bash
> Review the changes in my current git diff

[tool: bash_execute command="git diff"]

Let me analyze these changes...

**Summary:**
- Added input validation to user registration
- Fixed memory leak in event listeners
- Improved error messages

**Suggestions:**
1. Line 42: Consider using a more specific error type
2. Line 58: This could be extracted into a helper function
3. Line 73: Add a comment explaining the regex pattern

**Security:**
- ✓ Input sanitization looks good
- ✓ No obvious vulnerabilities

Overall, the changes look solid!
```

---

### Bug Investigation

Debug issues step-by-step:

```bash
> Help me debug why my tests are failing

Let me investigate. First, let's run the tests:

[tool: bash_execute command="npm test"]

Found 3 failing tests. Let me check the first one:

[tool: bash_execute command="npm test -- user.test.ts"]

The test is failing because... [analysis]

Let's check the implementation:

[tool: bash_execute command="cat src/user.ts"]

I see the issue! The function expects... [explanation]

**Fix:**
[Provides code fix with explanation]

**Why it works:**
[Detailed explanation]

Try this and run the tests again.
```

---

### Project Setup

Set up a new project with best practices:

```bash
> Set up a new TypeScript + React project with testing

I'll help you set up a complete project. Here's my plan:

1. Initialize package.json
2. Install TypeScript and React
3. Configure TypeScript
4. Set up Jest for testing
5. Add ESLint and Prettier
6. Create project structure

Let's start:

[tool: bash_execute command="npm init -y"]
[tool: bash_execute command="npm install react react-dom"]
[tool: bash_execute command="npm install -D typescript @types/react @types/react-dom"]

[Continues with setup steps...]

✅ Project setup complete!

**Structure created:**
```
my-project/
├── src/
│   ├── App.tsx
│   ├── App.test.tsx
│   └── index.tsx
├── tsconfig.json
├── jest.config.js
└── package.json
```

**Next steps:**
1. Run `npm start` to start dev server
2. Run `npm test` to run tests
3. Run `npm run build` to create production build
```

---

## Research & Learning

### Technology Research

Research a technology using web search:

```bash
> Search for WebAssembly performance compared to JavaScript

[tool: web_search query="WebAssembly vs JavaScript performance 2025"]

Top results on WebAssembly vs JavaScript performance:

1. **WebAssembly Performance Guide (MDN)**
   - Near-native speed for CPU-intensive tasks
   - 50-80% of native C++ performance
   - Best for: Image processing, games, simulations

2. **JavaScript vs WebAssembly Benchmark (2025)**
   - JavaScript faster for startup and DOM manipulation
   - WebAssembly shines in computational workloads
   - Use cases and trade-offs explained

3. **When to Use WebAssembly (web.dev)**
   - Decision tree for choosing between JS and WASM
   - Real-world performance comparisons
   - Tooling and ecosystem considerations

Based on these results, here's a summary:

**WebAssembly advantages:**
- Near-native performance for computations
- Predictable performance (no JIT warmup)
- Compact binary format

**JavaScript advantages:**
- Faster startup for small apps
- Direct DOM access
- Mature ecosystem

**Recommendation:** Use WebAssembly for CPU-intensive tasks like image/video processing, simulations, or games. Stick with JavaScript for DOM manipulation and most web apps.

Want me to search for more specific performance benchmarks?
```

---

### Learning New Concepts

Get explanations with examples:

```bash
> Explain React Server Components with a practical example

# React Server Components

## What They Are

Server Components render on the server and send HTML to the client,
reducing JavaScript bundle size and improving performance.

## Key Differences

**Server Component (default in Next.js 13+):**
```typescript
// app/components/UserList.tsx
async function UserList() {
  // This runs on the server
  const users = await fetch('https://api.example.com/users').then(r => r.json());

  return (
    <ul>
      {users.map(user => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  );
}
```

**Client Component:**
```typescript
'use client';  // Mark as client component

import { useState } from 'react';

function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button onClick={() => setCount(count + 1)}>
      Count: {count}
    </button>
  );
}
```

## When to Use Each

**Server Components for:**
- Data fetching
- Accessing backend resources
- Keeping sensitive data on server
- Large dependencies

**Client Components for:**
- Interactivity (onClick, onChange)
- State management (useState, useReducer)
- Browser APIs (localStorage, geolocation)
- React hooks (useEffect, etc.)

## Complete Example

[Provides full working example with file structure]

Would you like me to explain any specific aspect in more detail?
```

---

## Data Analysis

### Log Analysis

Analyze application logs:

```bash
> Analyze the error logs from yesterday

[tool: bash_execute command="grep ERROR /var/log/app.log | grep '2025-01-13'"]

Found 147 errors yesterday. Let me categorize them:

## Error Summary

**Database Connection Errors (89 instances)**
```
[2025-01-13 14:23:15] ERROR: Connection timeout to db-primary
```

Pattern: Peak at 2-3 PM, suggests database overload

**API Rate Limiting (42 instances)**
```
[2025-01-13 16:45:22] ERROR: Rate limit exceeded for /api/users
```

Pattern: Afternoon traffic spike

**Authentication Failures (16 instances)**
```
[2025-01-13 09:12:08] ERROR: Invalid token for user@example.com
```

Pattern: Isolated incidents, no pattern

## Recommendations

1. **Database**: Increase connection pool size or add read replica
2. **Rate Limiting**: Increase limits or add caching layer
3. **Auth**: Investigate if tokens are expiring prematurely

Want me to investigate any of these in detail?
```

---

### Data Transformation

Process and transform data:

```bash
> Convert this CSV data to JSON format and calculate averages

[tool: bash_execute command="cat data.csv"]

```csv
name,score,department
Alice,85,Engineering
Bob,92,Sales
Charlie,78,Engineering
```

Let me process this...

[tool: bash_execute command="python3 -c 'import csv, json; ...'"]

**JSON Output:**
```json
[
  {"name": "Alice", "score": 85, "department": "Engineering"},
  {"name": "Bob", "score": 92, "department": "Sales"},
  {"name": "Charlie", "score": 78, "department": "Engineering"}
]
```

**Statistics:**
- Average score: 85.0
- Engineering average: 81.5
- Sales average: 92.0
- Highest: Bob (92)
- Lowest: Charlie (78)
```

---

## DevOps Tasks

### Deployment Checks

Pre-deployment verification:

```bash
> Check if the app is ready to deploy

Running deployment checklist...

**1. Tests**
[tool: bash_execute command="npm test"]
✅ All tests passing (42 passed)

**2. Build**
[tool: bash_execute command="npm run build"]
✅ Build successful (no errors)

**3. Type Check**
[tool: bash_execute command="tsc --noEmit"]
✅ No TypeScript errors

**4. Lint**
[tool: bash_execute command="npm run lint"]
⚠️  3 warnings (non-blocking)
  - Unused variable at src/utils.ts:42
  - Missing prop types at src/components/Card.tsx:12
  - Console.log at src/debug.ts:8

**5. Security**
[tool: bash_execute command="npm audit"]
✅ No vulnerabilities

**6. Environment**
[tool: bash_execute command="cat .env.production"]
✅ All required env vars present

**Summary:**
✅ Ready to deploy
⚠️  Consider fixing lint warnings before deploying

Proceed with deployment? (yes/no)
```

---

### Log Monitoring

Monitor logs in real-time:

```bash
> Monitor the production logs for errors

Starting log monitor...

[tool: bash_execute command="tail -f /var/log/production.log"]

[10:32:15] INFO: Request received GET /api/users
[10:32:16] INFO: Response sent 200 (42ms)
[10:32:18] INFO: Request received POST /api/login
[10:32:19] ERROR: Authentication failed for user@example.com

⚠️  **Alert: Authentication Error**

Let me investigate:

[tool: bash_execute command="grep 'user@example.com' /var/log/production.log | tail -20"]

Pattern detected: User tried to log in 5 times in the last minute.
This looks like a brute force attempt.

**Recommendation:** Block IP or implement rate limiting on /api/login

Should I check if this IP has other suspicious activity?
```

---

## Content Creation

### Documentation Writing

Generate documentation from code:

```bash
> Generate API documentation for this Express route file

[tool: bash_execute command="cat src/routes/users.ts"]

Let me create comprehensive API documentation:

# User API Documentation

## Endpoints

### GET /api/users

Get a list of all users.

**Request:**
```
GET /api/users?page=1&limit=10
```

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)

**Response:**
```json
{
  "users": [
    {
      "id": "usr_123",
      "email": "user@example.com",
      "name": "John Doe",
      "createdAt": "2025-01-14T10:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 42,
    "totalPages": 5
  }
}
```

**Status Codes:**
- `200`: Success
- `401`: Unauthorized
- `500`: Server error

[Continues with other endpoints...]

### POST /api/users

Create a new user...

[Complete documentation with examples]

Would you like me to export this as a Markdown file?
```

---

### README Generation

Create project README:

```bash
> Generate a README for this TypeScript CLI project

[tool: bash_execute command="cat package.json"]
[tool: bash_execute command="ls src/"]

# My CLI Tool

## Overview

A command-line interface tool built with TypeScript that...

## Installation

```bash
npm install -g my-cli-tool
```

## Usage

```bash
my-cli [command] [options]
```

### Available Commands

- `my-cli start` - Start the service
- `my-cli stop` - Stop the service
- `my-cli status` - Check service status

### Examples

**Start with custom port:**
```bash
my-cli start --port 3000
```

**Check status:**
```bash
my-cli status
```

## Configuration

Create a `config.json` file:

```json
{
  "port": 3000,
  "host": "localhost"
}
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Run tests
npm test
```

## License

MIT

---

Generated comprehensive README! Would you like me to:
1. Add more sections (Contributing, API docs, etc.)
2. Export this to README.md
3. Create additional documentation files
```

---

## Automation Scripts

### Batch File Operations

Automate repetitive tasks:

```bash
> Rename all .jsx files to .tsx and add TypeScript types

I'll help you migrate from JSX to TSX. Here's my plan:

1. Find all .jsx files
2. Rename to .tsx
3. Add basic TypeScript types
4. Update imports

Let's start:

[tool: bash_execute command="find src -name '*.jsx'"]

Found 12 JSX files. Processing...

[tool: bash_execute command="for file in $(find src -name '*.jsx'); do ..."]

✅ Renamed 12 files

Now adding TypeScript types:

[For each file...]
[tool: bash_execute command="sed -i '' 's/export default function/export default function ComponentName(): JSX.Element/' src/Button.tsx"]

✅ Added basic types to 12 components

**Summary:**
- ✅ 12 files renamed (.jsx → .tsx)
- ✅ Basic TypeScript types added
- ⚠️  4 files need manual type refinement

**Files needing attention:**
1. src/ComplexComponent.tsx - Complex props need custom interface
2. src/AsyncComponent.tsx - Async operations need proper typing
...

Would you like me to help with the manual refinements?
```

---

### Git Automation

Automate git workflows:

```bash
> Create a feature branch, commit my changes, and push

I'll help you with that git workflow:

**1. Check current status:**
[tool: bash_execute command="git status"]

You have 3 modified files:
- src/App.tsx
- src/components/Button.tsx
- package.json

**2. Create feature branch:**
[tool: bash_execute command="git checkout -b feat/button-improvements"]

✅ Branch created: feat/button-improvements

**3. Stage changes:**
[tool: bash_execute command="git add ."]

✅ Changes staged

**4. Commit:**
[tool: bash_execute command="git commit -m 'feat(ui): improve button component styling and add hover effects'"]

✅ Commit created (abc1234)

**5. Push to remote:**
[tool: bash_execute command="git push -u origin feat/button-improvements"]

✅ Pushed to remote

**Summary:**
- Branch: feat/button-improvements
- Commit: feat(ui): improve button component styling and add hover effects
- URL: https://github.com/user/repo/tree/feat/button-improvements

Would you like me to create a pull request? (requires GitHub CLI)
```

---

## Tips for Effective Use

### 1. Be Specific

❌ **Vague:**
```bash
> Help with code
```

✅ **Specific:**
```bash
> Review my TypeScript interface for user authentication and suggest improvements
```

---

### 2. Provide Context

❌ **No context:**
```bash
> Fix the error
```

✅ **With context:**
```bash
> I'm getting "Cannot read property 'map' of undefined" in UserList.tsx line 42.
> Here's the code: [paste code]
```

---

### 3. Break Down Complex Tasks

❌ **Too broad:**
```bash
> Build a complete e-commerce website
```

✅ **Incremental:**
```bash
> Step 1: Create a product listing component with TypeScript
> [Complete step 1]
> Step 2: Add shopping cart functionality
> [And so on...]
```

---

### 4. Use Tools Explicitly

You can request specific tools:

```bash
> Use bash_execute to find all TODO comments in the codebase

[tool: bash_execute command="grep -r 'TODO' --include='*.ts' --include='*.tsx' ."]
```

---

### 5. Save Important Sessions

Don't forget to save:

```bash
# After completing complex work
/save migration-planning

# Later, you can refer back or resume
/sessions
```

---

## See Also

- [Features Guide →](/cli/features) - Detailed feature documentation
- [Commands Reference →](/cli/commands) - All available commands
- [Advanced Usage →](/cli/advanced-usage) - Best practices and tips
- [Troubleshooting →](/cli/troubleshooting) - Common issues
