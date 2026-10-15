---
title: Core Concepts
description: "Architecture has 3 concepts: Core (business logic), Contracts (interfaces), Outside (implementations + entry points)."
sidebar_position: 2
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Core Concepts

[← Back to README](./README.md)

<!-- SUMMARY -->
Architecture has 3 concepts: Core (business logic), Contracts (interfaces), Outside (implementations + entry points).
Core lives in packages/core/, knows nothing about infra or HTTP.
Wire everything together in the entry point at startup.
<!-- /SUMMARY -->

---

## The Simplified Model

<!-- ARCHITECTURE-DIAGRAM: Visual representation of the pattern -->

We keep things simple with just 3 concepts:

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

---

## The 3 Concepts

| Concept | Description | Location |
|---------|-------------|----------|
| **Core** | Your business logic (domain objects, actions, contracts) | `packages/core/src/` |
| **Contracts** | Interfaces that define what external things you need | `packages/core/src/{feature}/` or `packages/core/src/shared/` |
| **Outside** | Implementations of contracts + entry points | `packages/infra/src/` + `apps/client/pages/api/` |

---

## Monorepo Structure

### Why `apps/` and `packages/`?

This is a common monorepo convention that enforces architectural boundaries:

| Folder | Purpose | Contains |
|--------|---------|----------|
| `packages/` | **Shared libraries** - reusable code with no deployment context | Business logic, domain objects, contracts |
| `apps/` | **Deployable applications** - runnable apps that wire packages with infrastructure | HTTP server, CLI tools, workers |

**The key insight**:

```
packages/  = WHAT your business does (pure, portable)
apps/      = HOW it's deployed (wired, specific)
```

**Why this matters**:

- `packages/core/` has **zero dependencies on deployment context** - it doesn't know if it's running in an API server, CLI, or test
- `apps/client/` is a **specific deployment** that wires core logic with real infrastructure
- Enforces the "core knows nothing" rule at the folder level
- Makes it trivial to add new entry points (CLI, workers, admin dashboards) that reuse the same core

---

## Wiring It Together (Next.js Pages API)

The entry point creates implementations and wires everything together.

```typescript
// apps/client/pages/api/orders/index.ts
import { baseApi } from '@server/middlewares/baseApi';
import mongoose from 'mongoose';

// Infrastructure
import { OrderRepositoryMongo } from '@packages/infra/orders/OrderRepositoryMongo';
import { SendGridMailer } from '@packages/infra/shared/email/SendGridMailer';

// Core
import { createOrder } from '@packages/core/orders';
import { createOrderSchema } from '../validators/orderValidators';

const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    // Validate input
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    // Create implementations (fulfill contracts)
    const orderRepository = new OrderRepositoryMongo();
    const mailer = new SendGridMailer(
      process.env.SENDGRID_API_KEY!,
      'orders@myapp.com'
    );

    // Bundle dependencies
    const deps = { repository: orderRepository, mailer };

    // Call action
    const order = await createOrder(deps, req.ctx, parsed.data);
    res.status(201).json({ id: order.id });
  });

export default handler;
```

---

## Next Steps

- [Feature Design](./02-feature-design.md) - Decide what type of feature to build
- [Domain Objects](./03-domain-objects.md) - Learn about entities and business rules
- [Contracts](./04-contracts.md) - Learn about interfaces
- [Rules & Guidelines](./08-rules-and-guidelines.md) - Import rules and folder structure
