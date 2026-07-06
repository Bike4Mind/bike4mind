---
title: Architecture Overview
description: A pragmatic, simplified approach to application architecture that keeps business logic isolated from external systems.
sidebar_position: 0
slug: /architecture
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Application Architecture

A pragmatic, simplified approach to application architecture that keeps business logic isolated from external systems.

<!-- AGENT-ENTRY-POINT: Start here for task-based navigation -->

---

## AI Agent Quick Start

<!-- AGENT-NAVIGATION: Choose based on your task -->

### What Are You Trying to Do?

| Task | Start Here | Then Read |
|------|------------|-----------|
| **Implement a new feature** | [18-tutorial-building-products.md](./18-tutorial-building-products.md) | [00-quick-reference.md](./00-quick-reference.md) |
| **Add a new action to existing feature** | [05-actions.md](./05-actions.md) | [00-quick-reference.md](./00-quick-reference.md) |
| **Add a new entity** | [03-domain-objects.md](./03-domain-objects.md) | [04-contracts.md](./04-contracts.md) |
| **Add an API endpoint** | [06-entry-points.md](./06-entry-points.md) | [10-validation.md](./10-validation.md) |
| **Wire dependencies in main.ts** | [06-entry-points.md](./06-entry-points.md#wiring-dependencies-in-maints) | [13-cross-feature-communication.md](./13-cross-feature-communication.md) |
| **Fix a bug** | [03-domain-objects.md](./03-domain-objects.md) | [10-validation.md](./10-validation.md) |
| **Understand the architecture** | [01-core-concepts.md](./01-core-concepts.md) | [08-rules-and-guidelines.md](./08-rules-and-guidelines.md) |
| **Review code for violations** | [08-rules-and-guidelines.md](./08-rules-and-guidelines.md) | Anti-Pattern Detection section |
| **Write tests** | [15-testing.md](./15-testing.md) | - |
| **Add cross-feature logic** | [13-cross-feature-communication.md](./13-cross-feature-communication.md) | [02-feature-design.md](./02-feature-design.md) |

### Quick Reference

For immediate access to file paths, import rules, signatures, and templates:
**[00-quick-reference.md](./00-quick-reference.md)** - Read this first for any implementation task.

### Key Rules (Memorize These)

```
1. Core knows nothing about infra or HTTP
2. Dependencies are interfaces (contracts)
3. Wire implementations at startup in main.ts
4. User actions: (deps, ctx, input) → Promise<Result>
5. System actions: (deps, input) → Promise<Result>
6. Entities throw InvariantError, Actions throw NotFoundError/BusinessError
```

---

## The Essence

> **Your business logic shouldn't know about databases, HTTP, or any external system.**

Everything else is ceremony.

---

## Documentation Sections

### Essential (Start Here)

The core concepts every developer needs to understand:

| Section | Description |
|---------|-------------|
| [Quick Reference](./00-quick-reference.md) | File paths, import rules, signatures, templates - all in one place |
| [Core Concepts](./01-core-concepts.md) | The simplified model and monorepo structure |
| [Feature Design](./02-feature-design.md) | Deciding what type of feature to build (resource, orchestration, computation) |
| [Domain Objects](./03-domain-objects.md) | Entities with business rules and invariants |
| [Contracts](./04-contracts.md) | Interfaces that define external dependencies |
| [Actions](./05-actions.md) | Business operations that orchestrate the domain |
| [Entry Points](./06-entry-points.md) | HTTP API, CLI, and Workers - how the outside world calls your app |
| [Infrastructure](./07-infrastructure.md) | Implementations of contracts (DB, Email, etc.) |
| [Rules & Guidelines](./08-rules-and-guidelines.md) | Import rules, naming conventions, anti-patterns, and common mistakes |

### Decision Guides

References for common architectural decisions:

| Section | Description |
|---------|-------------|
| [Where to Put Logic](./03-domain-objects.md) | Entity vs Action - the most common question |
| [Authorization](./09-authorization.md) | Policies, permissions, and AuthContext |
| [Validation](./10-validation.md) | Input, business, and invariant validation layers |

### Advanced Patterns

Use when your application needs them:

| Section | Description |
|---------|-------------|
| [CQRS and Read Models](./11-cqrs-and-read-models.md) | Separate read/write models for complex query needs |
| [Transactions](./12-transactions.md) | Database transactions and atomicity |
| [Shared Contracts](./04-contracts.md) | Sharing contracts across features |
| [Cross-Feature Communication](./13-cross-feature-communication.md) | Action-based dependencies between features |
| [The Shared Package](./14-shared-package.md) | Sharing types with frontend apps |
| [Dependency Management](./17-dependency-management.md) | Organizing dependencies as your app grows |

### Reliability

Patterns for robust, observable systems:

| Section | Description |
|---------|-------------|
| [Error Handling](./16-error-handling.md) | Error types, Result pattern, partial failures |
| [Logging](./07-infrastructure.md) | Structured logging, boundaries, and observability |

### Quality

| Section | Description |
|---------|-------------|
| [Testing](./15-testing.md) | Testing strategies with fakes |

### Tutorials

| Section | Description |
|---------|-------------|
| [Building a Products Feature](./18-tutorial-building-products.md) | Complete end-to-end walkthrough building a feature from scratch |

---

## Quick Start

### The Simplified Model

```
┌─────────────────────────────────────┐
│              OUTSIDE                │
│   (HTTP, DB, Files, APIs, etc.)     │
│                                     │
│         ┌───────────────┐           │
│         │   CONTRACTS   │           │
│         │ (Interfaces)  │           │
│         └───────┬───────┘           │
│                 │                   │
│         ┌───────▼───────┐           │
│         │     CORE      │           │
│         │  (Your App)   │           │
│         └───────────────┘           │
└─────────────────────────────────────┘
```

Just **3 concepts**:

| Concept | Description |
|---------|-------------|
| **Core** | Your business logic (domain objects, actions, contracts) |
| **Contracts** | Interfaces that define what external things you need |
| **Outside** | Implementations of contracts + entry points (API, CLI) |

---

## Folder Structure

```
├── apps/
│   ├── client/                   # Next.js App (Frontend + API)
│   │   ├── pages/
│   │   │   └── api/              # Entry points (Next.js API Routes)
│   │   │       ├── validators/   # Input validation schemas
│   │   │       └── handlers/     # Request handlers
│   │   └── server/               # Server-side code
│   │       └── middlewares/
│   │           └── baseApi.ts    # Base API middleware factory
│   │
│   └── worker/                   # Background workers (optional)
│       └── src/
│           └── ...
│
└── packages/
    ├── core/                     # Business logic (backend only)
    │   └── src/
    │       ├── shared/           # Shared contracts across features
    │       │   ├── authorization/
    │       │   │   └── AuthContext.ts
    │       │   ├── Mailer.ts
    │       │   ├── Logger.ts
    │       │   ├── TransactionManager.ts
    │       │   ├── Result.ts
    │       │   └── errors.ts
    │       │
    │       └── orders/           # Feature: Orders
    │           ├── Order.ts      # Entity (write model)
    │           ├── OrderRepository.ts  # Combined read/write contract
    │           ├── OrderReadModels.ts  # DTOs for queries
    │           ├── OrderPolicies.ts
    │           ├── actions/      # Commands (writes)
    │           │   ├── createOrder.ts
    │           │   └── cancelOrder.ts
    │           ├── queries/      # Queries (reads)
    │           │   ├── getOrderDetails.ts
    │           │   └── listCustomerOrders.ts
    │           └── index.ts
    │
    ├── infra/                    # Infrastructure implementations
    │   └── src/
    │       ├── shared/           # Shared infra (core/shared contracts)
    │       │   ├── mongodb/
    │       │   │   ├── connection.ts
    │       │   │   ├── BaseMongoRepository.ts
    │       │   │   └── MongoTransactionManager.ts
    │       │   ├── email/
    │       │   │   └── SendGridMailer.ts
    │       │   └── logging/
    │       │       └── PinoLogger.ts
    │       │
    │       └── orders/           # Feature infra (core/orders contracts)
    │           ├── OrderRepositoryMongo.ts
    │           └── memory/
    │               └── InMemoryOrderRepository.ts
    │
    └── shared/                   # Shared with frontend
        └── src/
            ├── api-types/        # Request/Response DTOs
            │   ├── orders.ts
            │   └── users.ts
            ├── validation/       # Zod schemas
            │   └── orders.ts
            └── constants/
                └── orderStatuses.ts
```

For import rules and guidelines, see [Rules & Guidelines](./08-rules-and-guidelines.md).

---

## The Mental Model

```
"My business logic is in core/.
 It talks to the outside world through interfaces.
 I plug in real implementations at startup."
```

That's the whole pattern.
