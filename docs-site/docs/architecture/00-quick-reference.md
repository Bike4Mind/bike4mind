---
title: Quick Reference for AI Agents
description: Essential architecture patterns in one place — file paths, import rules, signatures, and templates. Read this first before implementing features.
sidebar_position: 1
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Quick Reference for AI Agents

[← Back to README](./README.md)

<!-- AGENT-INSTRUCTIONS: Read this file first before implementing features. This contains all essential patterns in one place. -->

---

## The Core Principle

> **Your business logic shouldn't know about databases, HTTP, or any external system.**

---

## File Path Templates

<!-- FILE-PATHS: Use these exact patterns when creating files -->

| Component | Path Pattern | Example |
|-----------|--------------|---------|
| Entity | `packages/core/src/{feature}/{Name}.ts` | `packages/core/src/orders/Order.ts` |
| Repository Contract | `packages/core/src/{feature}/{Name}Repository.ts` | `packages/core/src/orders/OrderRepository.ts` |
| Policies | `packages/core/src/{feature}/{Name}Policies.ts` | `packages/core/src/orders/OrderPolicies.ts` |
| User Action | `packages/core/src/{feature}/actions/{verbNoun}.ts` | `packages/core/src/orders/actions/createOrder.ts` |
| System Action | `packages/core/src/{feature}/actions/system{VerbNoun}.ts` | `packages/core/src/orders/actions/systemExpireOrders.ts` |
| Query | `packages/core/src/{feature}/queries/{getOrList}{Noun}.ts` | `packages/core/src/orders/queries/getOrderDetails.ts` |
| Feature Index | `packages/core/src/{feature}/index.ts` | `packages/core/src/orders/index.ts` |
| Shared Contract | `packages/core/src/shared/{Name}.ts` | `packages/core/src/shared/Mailer.ts` |
| Shared Errors | `packages/core/src/shared/errors.ts` | `packages/core/src/shared/errors.ts` |
| AuthContext | `packages/core/src/shared/authorization/AuthContext.ts` | - |
| Infra Implementation | `packages/infra/src/{feature}/{Name}Repository{Provider}.ts` | `packages/infra/src/orders/OrderRepositoryMongo.ts` |
| Infra Shared | `packages/infra/src/shared/{technology}/{Name}.ts` | `packages/infra/src/shared/email/SendGridMailer.ts` |
| Infra Test Fake | `packages/infra/src/{feature}/memory/InMemory{Name}.ts` | `packages/infra/src/orders/memory/InMemoryOrderRepository.ts` |
| Handler | `apps/client/pages/api/{feature}/{endpoint}.ts` | `apps/client/pages/api/orders/index.ts` |
| Validator | `packages/shared/src/validation/{feature}.ts` | `packages/shared/src/validation/orders.ts` |

---

## Import Rules

<!-- IMPORT-RULES: CRITICAL - Violations break the architecture -->

### Allowed Imports

```
apps/client/pages/api/    → @packages/core, @packages/infra, @packages/shared
apps/client/server/       → everything
apps/client/              → @packages/shared (for frontend components)
@packages/core            → @packages/shared
@packages/infra           → @packages/core, @packages/shared
```

### Forbidden Imports

```
@packages/core            → @packages/infra       ❌ NEVER
@packages/core            → apps/                 ❌ NEVER
@packages/infra           → apps/                 ❌ NEVER
@packages/infra/{feature} → @packages/infra/{other-feature}  ❌ NEVER
@packages/shared          → @packages/core        ❌ NEVER
@packages/shared          → @packages/infra       ❌ NEVER
@packages/shared          → apps/                 ❌ NEVER
```

### Cross-Feature Rule

```
@packages/core/src/orders → @packages/core/src/customers  ❌ NEVER import directly
```

Use **function dependencies** instead (for both reading AND writing). See [Cross-Feature Communication](./13-cross-feature-communication.md).

---

## Infrastructure Placement Rule

<!-- INFRA-PLACEMENT: Single rule for where infra goes -->

**Follow the contract location:**

```
Contract Location               →  Implementation Location
─────────────────────────────────────────────────────────────
core/shared/Mailer.ts           →  infra/shared/email/SendGridMailer.ts
core/orders/OrderRepository.ts  →  infra/orders/OrderRepositoryMongo.ts
```

| Contract In | Implementation In |
|-------------|-------------------|
| `core/shared/` | `infra/shared/{technology}/` |
| `core/{feature}/` | `infra/{feature}/` |
| Infrastructure plumbing | `infra/shared/{technology}/` |
| Test fakes | `infra/{feature}/memory/` |

---

## When to Use `core/shared/`

<!-- SHARED-DECISION: Determine if something belongs in core/shared/ -->

### Decision Guide

| Question | Yes → | No → |
|----------|-------|------|
| Is it used by **2+ features**? | `core/shared/` | Keep in feature |
| Is it a **cross-cutting concern**? (auth, logging, errors, transactions) | `core/shared/` | Keep in feature |
| Does **every action** need it? (e.g., AuthContext) | `core/shared/` | Keep in feature |

### What Belongs in `core/shared/`

| Category | Examples | Why Shared |
|----------|----------|------------|
| **Authorization** | `AuthContext.ts` | Every user action needs auth context |
| **Cross-cutting services** | `Mailer.ts`, `Logger.ts` | Multiple features send emails/log |
| **Error types** | `errors.ts` | Consistent error handling across features |
| **Transaction handling** | `TransactionManager.ts` | Any feature may need atomic operations |
| **Common patterns** | `Result.ts` | Standardized return types across actions |

### Migration Rule

> **Start in feature, promote to shared when needed.**

Don't preemptively put contracts in `core/shared/`. See [Contracts - When to Use Shared](./04-contracts.md#when-to-use-coreshared) for detailed guidance.

---

## Lightweight Contract Pattern

When you only need to read data from another domain, define a minimal repository interface:

```typescript
// core/agents/AgentRepository.ts
export interface AgentReadData { id: string; name: string; /* ... */ }
export interface AgentRepository {
  findByIds(ids: string[]): Promise<AgentReadData[]>;
}
```

No need for a full entity — a read-only DTO + repository contract is sufficient.

---

## System vs User Action Decision

| If the request originates from... | Use... |
|----------------------------------|--------|
| API route, queue processing a user request | User action `(deps, ctx, input)` |
| Cron job, system maintenance | System action `(deps, input)` |

---

## Action Signatures

<!-- ACTION-SIGNATURES: Always follow these exact patterns -->

### User Action (called by API handlers, CLI with auth)

```typescript
export async function {actionName}(
  deps: {ActionName}Deps,      // 1. Dependencies (repositories, services)
  ctx: AuthContext,            // 2. Auth context (who's calling)
  input: {ActionName}Input     // 3. Action-specific data
): Promise<{ReturnType}>
```

### System Action (called by workers, schedulers, migrations)

```typescript
export async function system{ActionName}(
  deps: {ActionName}Deps,      // 1. Dependencies (repositories, services)
  input: {ActionName}Input     // 2. Action-specific data (NO ctx)
): Promise<{ReturnType}>
```

---

## Action Pattern

<!-- ACTION-PATTERN: Follow this order in every action -->

```
1. LOAD      → Fetch required data from repositories
2. AUTHORIZE → Check permissions using policies (user actions only)
3. VALIDATE  → Business validation (DB lookups, cross-feature checks)
4. EXECUTE   → State changes via entity methods
5. PERSIST   → Save to repository
6. SIDE EFFECTS → Emails, notifications, analytics (non-critical)
```

---

## Error Types

<!-- ERROR-TYPES: Use the correct error for each situation -->

| Error | Thrown By | HTTP | When to Use |
|-------|-----------|------|-------------|
| `NotFoundError` | Action | 404 | Resource doesn't exist in database |
| `BusinessError` | Action | 422 | Business rule prevents operation |
| `InvariantError` | Entity | 422 | Invalid state transition attempted |

For error class definitions and handling patterns, see [Error Handling](./16-error-handling.md).

---

## Feature Types Decision

<!-- FEATURE-TYPE-DECISION: Determine what type of feature to create -->

| Question | Yes → | No → |
|----------|-------|------|
| Does it OWN data that needs persistence? | **Resource Feature** | Continue ↓ |
| Does it COORDINATE multiple features? | **Orchestration Feature** | Continue ↓ |
| Does it CALCULATE or TRANSFORM data? | **Computation Feature** | Not a separate feature |

### What Each Type Needs

| Feature Type | Entity | Repository | Policies | Actions |
|--------------|--------|------------|----------|---------|
| Resource | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| Orchestration | ❌ No | ❌ No | Optional | ✅ Yes (with function deps) |
| Computation | ❌ No | ❌ No | Optional | ✅ Yes (pure functions) |

---

## Where to Put Logic

<!-- LOGIC-PLACEMENT: Quick decision guide -->

| Put in Entity | Put in Action |
|---------------|---------------|
| State transitions (`submit()`, `cancel()`) | Authorization (policy checks) |
| State validation (`canCancel()`) | Database operations (load, save) |
| Computed properties (`get total()`) | External API calls |
| Invariants (throw `InvariantError`) | Side effects (email, analytics) |
| Core calculations | Business validation requiring DB |

**Rule of thumb**: If it needs `await`, it goes in Action.

---

## Naming Conventions

<!-- NAMING: Follow these patterns exactly -->

### Files

| Type | Pattern | Example |
|------|---------|---------|
| Entity | `{Name}.ts` (PascalCase, singular) | `Order.ts` |
| Contract | `{Name}Repository.ts` | `OrderRepository.ts` |
| User Action | `{verbNoun}.ts` (camelCase) | `createOrder.ts` |
| System Action | `system{VerbNoun}.ts` | `systemExpireOrders.ts` |
| Feature Infra | `{Name}Repository{Provider}.ts` | `OrderRepositoryMongo.ts` |
| Shared Infra | `{Name}{Provider}.ts` | `SendGridMailer.ts` |
| Test Fake | `InMemory{Name}.ts` | `InMemoryOrderRepository.ts` |
| Validator | `{feature}.ts` | `orders.ts` |

### Code

| Type | Pattern | Example |
|------|---------|---------|
| Entity class | PascalCase | `class Order` |
| Interface | PascalCase | `interface OrderRepository` |
| Action function | camelCase | `function createOrder()` |
| Error class | PascalCase + Error | `class NotFoundError` |
| Type | PascalCase | `type OrderStatus` |

---

## Validation Layers

<!-- VALIDATION-LAYERS: Three distinct layers -->

| Layer | Location | Validates | Fails With |
|-------|----------|-----------|------------|
| Input | API Handler | Data shape, format, types | 400 Bad Request |
| Business | Action | DB lookups, permissions, rules | 404 / 422 |
| Invariant | Entity | State transitions | 422 |

---

## Dependencies Interface Pattern

<!-- DEPS-PATTERN: How to define action dependencies -->

```typescript
// For single-feature actions
export interface CreateOrderDeps {
  repository: OrderRepository;
  mailer: Mailer;
}

// For cross-feature actions (use function dependencies - both read AND write)
export interface CreateOrderDeps {
  repository: OrderRepository;
  mailer: Mailer;
  // Read from other features
  getCustomer: (customerId: string) => Promise<CustomerData | null>;
  checkStock: (productId: string, quantity: number) => Promise<StockResult>;
  // Write to other features - equally valid!
  updateQuest: (questId: string, data: QuestUpdateData) => Promise<void>;
}
```

**Important**: Define data interfaces (`CustomerData`, `StockResult`, `QuestUpdateData`) in the action file, not imported from other features. Function dependencies work for both reading and writing cross-feature data.

---

## AuthContext & Policies

<!-- AUTH-CONTEXT: Standard authentication context -->

For AuthContext definition and policy patterns, see [Authorization](./09-authorization.md).

---

## Policy Pattern

<!-- POLICY-PATTERN: Authorization checks -->

```typescript
// packages/core/src/orders/OrderPolicies.ts
export const OrderPolicies = {
  canCreate(ctx: AuthContext): boolean {
    return ctx.roles.includes('customer') || ctx.isAdmin;
  },

  canCancel(ctx: AuthContext, order: Order): boolean {
    return order.customerId === ctx.userId || ctx.isAdmin;
  },

  canView(ctx: AuthContext, order: Order): boolean {
    return order.customerId === ctx.userId || ctx.isAdmin;
  },
};
```

---

## Handler Pattern (Next.js Pages API)

<!-- HANDLER-PATTERN: API handler structure -->

```typescript
// apps/client/pages/api/orders/index.ts
import { baseApi } from '@server/middlewares/baseApi';
import { createOrderSchema } from '@packages/shared/validation/orders';
import { createOrder } from '@packages/core/orders';

const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    // 1. Validate input
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    // 2. Call action
    const order = await createOrder(deps, req.ctx, parsed.data);
    res.status(201).json({ id: order.id });
  });

export default handler;
```

---

## Wiring Dependencies in main.ts

<!-- WIRING: Critical pattern for connecting everything -->

Dependencies are constructed **once at startup** in the middleware/server setup, not in handlers.

```typescript
// apps/client/server/middlewares/baseApi.ts or similar setup
// Create dependencies (can also be done in middleware factory)
const deps = {
  repository: new OrderRepositoryMongo(),
  mailer: new SendGridMailer(process.env.SENDGRID_API_KEY!, 'orders@myapp.com'),
};

// For cross-feature deps, create factories that bind AuthContext
const createOrderDeps = (ctx: AuthContext) => ({
  repository: orderRepository,
  mailer,
  getCustomer: async (id: string) => {
    const c = await getCustomer(customerDeps, ctx, { customerId: id });
    return c ? { id: c.id, email: c.email, isInGoodStanding: c.status === 'active' } : null;
  },
});
```

| Rule | Why |
|------|-----|
| **Wire at startup** | Shared connection pools, fail-fast on bad config |
| **Inject, don't construct** | Handlers receive deps, don't create them |
| **Use factories for cross-feature** | Binds AuthContext to function dependencies |

For complete examples, see [Entry Points - Wiring Dependencies](./06-entry-points.md#wiring-dependencies-in-maints).

---

## Quick Checklist: New Resource Feature

<!-- CHECKLIST-RESOURCE: Steps to create a resource feature -->

1. [ ] `packages/core/src/{feature}/{Name}.ts` - Entity
2. [ ] `packages/core/src/{feature}/{Name}Repository.ts` - Contract
3. [ ] `packages/core/src/{feature}/{Name}Policies.ts` - Authorization
4. [ ] `packages/core/src/{feature}/actions/{verb}{Name}.ts` - Actions
5. [ ] `packages/core/src/{feature}/index.ts` - Exports
6. [ ] `packages/infra/src/{feature}/{Name}Repository{Provider}.ts` - Implementation
7. [ ] `packages/infra/src/{feature}/memory/InMemory{Name}Repository.ts` - Test fake
8. [ ] `packages/shared/src/validation/{feature}.ts` - Input validation
9. [ ] `apps/client/pages/api/{feature}/index.ts` - HTTP handlers
10. [ ] Wire dependencies in handler or middleware

---

## Related Documentation

| Topic | File |
|-------|------|
| **Tutorial: Build a feature** | [18-tutorial-building-products.md](./18-tutorial-building-products.md) |
| Core concepts | [01-core-concepts.md](./01-core-concepts.md) |
| Feature types | [02-feature-design.md](./02-feature-design.md) |
| Entities | [03-domain-objects.md](./03-domain-objects.md) |
| Contracts | [04-contracts.md](./04-contracts.md) |
| Actions | [05-actions.md](./05-actions.md) |
| Entry points & wiring | [06-entry-points.md](./06-entry-points.md) |
| Infrastructure | [07-infrastructure.md](./07-infrastructure.md) |
| Rules | [08-rules-and-guidelines.md](./08-rules-and-guidelines.md) |
| Logic placement | [03-domain-objects.md](./03-domain-objects.md) |
| Authorization | [09-authorization.md](./09-authorization.md) |
| Validation | [10-validation.md](./10-validation.md) |
| Testing | [15-testing.md](./15-testing.md) |
| Error handling | [16-error-handling.md](./16-error-handling.md) |
