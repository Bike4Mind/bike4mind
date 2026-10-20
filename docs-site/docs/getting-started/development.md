---
title: Development Setup
description: Set up a local development environment to contribute to the Bike4Mind open core
sidebar_position: 3
---

# Development Setup

This page gets you from zero to a verified local development environment for contributing to the [Bike4Mind open core](https://github.com/bike4mind/bike4mind). For the full contribution process (CLA, issue-first workflow, PR requirements), read the repo's [Contributing Guide](https://github.com/bike4mind/bike4mind/blob/main/CONTRIBUTING.md).

## Prerequisites

- **Git**
- **Node.js 24.x** (see `.nvmrc` - use `nvm use`)
- **pnpm** (`npm install -g pnpm`)
- **Docker** (for running MongoDB locally via `compose.yaml`)
- **Gitleaks** (`brew install gitleaks` or your package manager) - used by the pre-commit hook

## Install, build, verify

```bash
# 1. Fork the repo on GitHub, then:
git clone git@github.com:<your-username>/bike4mind.git
cd bike4mind
git remote add upstream git@github.com:bike4mind/bike4mind.git

# 2. Install dependencies (all workspaces)
pnpm i -r

# 3. Install the git hooks (gitleaks secret scan + lint-staged)
./install-hooks.sh

# 4. Build the core packages (dependency-ordered, cached)
pnpm turbo:core:build

# 5. Verify your environment works before changing anything
pnpm turbo:typecheck   # TypeScript across all packages
pnpm turbo:test        # all test suites (MongoDB tests use mongodb-memory-server - no local DB needed)
pnpm lint:check        # ESLint, error severity only (mirrors the CI gate)
```

If all three pass on a clean checkout, you're ready. **Most contributions can be fully developed and validated with just typecheck + tests + lint** - you do not need AWS access or a running full stack to fix a bug in the engine, adapters, or data models.

To run the full application locally (needed for UI work), see [Self-Hosting](/self-host). `compose.yaml` provides a local MongoDB replica set (`docker compose up db`).

## Where the code lives

```
├── apps/
│   ├── client/              # Next.js app - SPA (Tanstack Router) + API routes
│   │   └── server/          # Backend service code behind the API routes
│   ├── cli/                 # B4M CLI - edge agent
│   └── subscriber-fanout/   # Real-time WebSocket fanout
├── b4m-core/                # The core engine - published as @bike4mind/* npm packages
│   ├── agents/ services/ utils/ common/   # Agent framework
│   ├── llm-adapters/        # Anthropic, OpenAI, Gemini, X.ai, Ollama adapters
│   └── mcp/ slack/ voice/ ...             # Capabilities
├── packages/
│   └── database/            # Mongoose models & migrations
├── docs-site/               # This documentation
└── infra/                   # SST/AWS infrastructure
```

Quick orientation for common contribution targets:

| I want to work on... | Start in |
|---|---|
| Agent behavior, tools, ReAct loop | `b4m-core/agents`, and see [Agents](/agents) |
| A new LLM provider | `b4m-core/llm-adapters` |
| The CLI | `apps/cli`, and see [CLI docs](/cli) |
| API routes / backend | `apps/client/server`, and see [API docs](/api) |
| Data models | `packages/database` |
| These docs | `docs-site/` |

Build order for core packages: `common → utils → agents → services → slack` (handled automatically by `pnpm turbo:core:build`).

## Useful commands

| Task | Command | Notes |
|---|---|---|
| Typecheck (fast) | `pnpm turbo:typecheck` | Cached |
| Run all tests | `pnpm turbo:test` | Parallel across packages |
| Test one package | `pnpm --filter <package> test` | e.g. `pnpm --filter @bike4mind/agents test` |
| Lint | `pnpm lint:check` | Mirrors CI |
| Build core packages | `pnpm turbo:core:build` | Add `--force` if builds seem stale |

:::warning
Do **not** run unfiltered `turbo build` - it attempts to build the SST-managed apps outside their deploy context and will fail. If you see unexpected type errors after pulling from `main`, rebuild: `pnpm i -r && pnpm turbo:core:build`.
:::

## Next steps

- Read the [Contributing Guide](https://github.com/bike4mind/bike4mind/blob/main/CONTRIBUTING.md) for the issue-first workflow, CLA, and PR requirements
- Look for issues labeled `good first issue` or `help wanted`
- Ask questions in [GitHub Discussions](https://github.com/bike4mind/bike4mind/discussions)
