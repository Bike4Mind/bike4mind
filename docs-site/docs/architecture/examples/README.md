---
title: Examples Overview
description: Framework-specific implementations of the architecture patterns — concrete implementations for specific frameworks and runtimes.
sidebar_position: 1
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Examples

Framework-specific implementations of the architecture patterns.

The main documentation in `architecture/` covers **principles and patterns**. This folder contains **concrete implementations** for specific frameworks and runtimes.

---

## Available Examples

| Example | Framework | Description |
|---------|-----------|-------------|
| [nextjs-api.md](./nextjs-api.md) | Next.js App Router | API routes with App Router, singleton deps, serverless considerations |

---

## Adding Examples

When adding a new example:

1. Focus on **how the pattern adapts** to the framework, not re-explaining the pattern
2. Include complete, copy-paste ready code
3. Highlight **key differences** from the Next.js Pages API baseline in main docs
4. Note any **framework-specific gotchas** (serverless, cold starts, etc.)

---

## Request an Example

Need an example for a framework not listed? Common candidates:

- Express
- Fastify
- Hono
- NestJS
- tRPC
- Serverless Framework (AWS Lambda)
- Cloudflare Workers
