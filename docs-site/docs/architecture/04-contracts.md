---
title: Contracts (Interfaces)
description: A contract is an interface — a promise of "what" without "how".
sidebar_position: 5
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Contracts (Interfaces)

[← Back to README](./README.md)

---

## What Is a Contract?

A **contract** is an interface - a promise of "what" without "how".

Think of it like a job description:

```typescript
// This is a contract
interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}
```

It says:
- "I need something that can send emails"
- "I don't care HOW it sends them"

---

## Why Use Contracts?

The contract doesn't know if you're using:
- SendGrid
- Mailgun
- AWS SES
- A fake that logs to console
- A test spy that records calls

This gives you:
- **Testability** - Swap real implementations for fakes
- **Flexibility** - Change providers without changing core
- **Decoupling** - Core doesn't depend on external systems

---

## Where Contracts Live

**Rule**: The contract lives with whoever NEEDS it, not whoever IMPLEMENTS it.

```
packages/
├── core/
│   └── src/
│       ├── orders/
│       │   ├── OrderRepository.ts      # Only orders needs this
│       │   └── ...
│       │
│       └── shared/
│           └── Mailer.ts          # Multiple features need this
│
└── infra/
    └── src/
        ├── orders/
        │   └── OrderRepositoryMongo.ts   # Implements OrderRepository
        └── shared/
            └── email/
                └── SendGridMailer.ts       # Implements Mailer
```

---

## Example: Repository Contract

A repository contract defines how to persist and retrieve domain objects:

```typescript
// packages/core/src/orders/OrderRepository.ts
import { Order } from './Order';

export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
  findByCustomer(customerId: string): Promise<Order[]>;
}
```

### Adding Read Operations (CQRS)

When you need both write operations (entities) and read operations (DTOs), extend your repository:

```typescript
// packages/core/src/orders/OrderRepository.ts
import { Order } from './Order';
import { OrderDetails, OrderSummary } from './OrderReadModels';

export interface OrderRepository {
  // Writes (entities)
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;

  // Reads (DTOs)
  getDetails(orderId: string): Promise<OrderDetails | null>;
  listByCustomer(customerId: string): Promise<OrderSummary[]>;
}
```

See [CQRS and Read Models](./11-cqrs-and-read-models.md) for details on when to use this pattern.

---

## Example: Mailer Contract

```typescript
// packages/core/src/shared/Mailer.ts
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}
```

---

## Example: Payment Gateway Contract

```typescript
// packages/core/src/shared/PaymentGateway.ts
export interface PaymentResult {
  success: boolean;
  transactionId: string;
  error?: string;
}

export interface PaymentGateway {
  charge(customerId: string, amount: number): Promise<PaymentResult>;
  refund(transactionId: string, amount: number): Promise<PaymentResult>;
}
```

---

## Example: Event Bus Contract

```typescript
// packages/core/src/shared/EventBus.ts
export interface Event {
  type: string;
  payload: unknown;
  timestamp: Date;
}

export interface EventBus {
  publish(event: Event): Promise<void>;
  subscribe(type: string, handler: (event: Event) => Promise<void>): void;
}
```

---

## Example: Logger Contract

For detailed logging patterns and implementation, see [Logging](./07-infrastructure.md).

```typescript
// packages/core/src/shared/Logger.ts
export interface LogData {
  requestId: string;
  event: string;
  [key: string]: unknown;
}

export interface Logger {
  info(data: LogData): void;
  warn(data: LogData): void;
  error(data: LogData): void;
}
```

---

## Contract Design Guidelines

### 1. Keep It Minimal

Only define what you actually need:

```typescript
// ❌ Too broad - you probably don't need all this
interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
  findByCustomer(customerId: string): Promise<Order[]>;
  findByStatus(status: string): Promise<Order[]>;
  findByDateRange(start: Date, end: Date): Promise<Order[]>;
  findAll(): Promise<Order[]>;
  count(): Promise<number>;
  delete(id: string): Promise<void>;
  // ... 20 more methods
}

// ✅ Start minimal, add as needed
interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
}
```

### 2. Use Domain Types

Return domain objects, not raw data:

```typescript
// ❌ Returns raw data
interface OrderRepository {
  findById(id: string): Promise<{
    id: string;
    customer_id: string;
    items: string;
    status: string;
  } | null>;
}

// ✅ Returns domain object
interface OrderRepository {
  findById(id: string): Promise<Order | null>;
}
```

### 3. Be Explicit About Async

Database and network operations are async:

```typescript
// ✅ Explicit Promise return types
interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
}
```

### 4. Handle Not Found

Use `null` for "not found" instead of throwing:

```typescript
interface OrderRepository {
  // Returns null if not found, action decides what to do
  findById(id: string): Promise<Order | null>;
}
```

---

## When to Use `core/shared/`

<!-- SHARED-DECISION: Detailed guidance for core/shared/ placement -->

### Decision Guide

Ask these questions in order:

| Question | Yes → | No → |
|----------|-------|------|
| Is it used by **2+ features**? | `core/shared/` | Keep in feature |
| Is it a **cross-cutting concern**? (auth, logging, errors, transactions) | `core/shared/` | Keep in feature |
| Does **every action** need it? (e.g., AuthContext) | `core/shared/` | Keep in feature |
| Is it **infrastructure-agnostic** and reusable? | `core/shared/` | Keep in feature |

**Rule**: The contract lives with whoever NEEDS it, not whoever IMPLEMENTS it.

---

### What Belongs in `core/shared/`

| Category | Examples | Why Shared |
|----------|----------|------------|
| **Authorization** | `AuthContext.ts` | Every user action needs auth context |
| **Cross-cutting services** | `Mailer.ts`, `Logger.ts` | Multiple features send emails/log |
| **Error types** | `errors.ts` (NotFoundError, BusinessError, InvariantError) | Consistent error handling across features |
| **Transaction handling** | `TransactionManager.ts` | Any feature may need atomic operations |
| **Common patterns** | `Result.ts` | Standardized return types across actions |

---

### What Does NOT Belong in `core/shared/`

| Keep In Feature | Reason |
|-----------------|--------|
| Feature-specific contracts | `OrderRepository` is only used by orders feature |
| Feature-specific types | `OrderStatus` enum belongs with Order entity |
| Feature policies | `OrderPolicies` only authorizes order operations |
| Domain value objects | `Money`, `Address` belong with the feature that owns them |

---

### Migration Rule

> **Start in feature, promote to shared when needed.**

Don't preemptively put contracts in `core/shared/`. When a second feature needs the same contract:

1. Move the contract to `core/shared/`
2. Move the implementation to `infra/shared/{technology}/`
3. Update imports in both features

#### Example: Promoting a Contract

```
Before: Only orders feature sends emails
  → Mailer contract in core/orders/Mailer.ts
  → SendGridMailer in infra/orders/SendGridMailer.ts

After: Customers feature also needs to send emails
  → Move Mailer to core/shared/Mailer.ts
  → Move SendGridMailer to infra/shared/email/SendGridMailer.ts
  → Update imports in both features
```

---

### Quick Reference

| Situation | Location |
|-----------|----------|
| Only `orders/` needs `OrderRepository` | `core/orders/OrderRepository.ts` |
| Both `orders/` and `users/` need `Mailer` | `core/shared/Mailer.ts` |
| Every action needs `AuthContext` | `core/shared/authorization/AuthContext.ts` |
| All features use same error types | `core/shared/errors.ts` |

---

### Shared Contract Example

```typescript
// packages/core/src/shared/Mailer.ts
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}
```

Used by multiple features:
```typescript
// packages/core/src/orders/actions/createOrder.ts
import { Mailer } from '../../shared/Mailer';

// packages/core/src/users/actions/registerUser.ts
import { Mailer } from '../../shared/Mailer';
```

---

### Guidelines

1. **Start in feature, move when needed** - Don't share prematurely
2. **Keep shared contracts simple** - Complex contracts may need a dedicated feature
3. **Avoid vague names** - Use `shared/`, not `utils/` or `common/`

---

### When to Promote Shared to a Feature

If a shared contract grows too complex, consider promoting it to a full feature:

| Signal | Action |
|--------|--------|
| Many email templates needed | Create `notifications/` feature |
| Complex payment flows | Create `payments/` feature |
| Multiple providers with business logic | Consider dedicated feature |
| Contract has its own entities | Definitely needs a feature |

---

## Next Steps

- [Actions](./05-actions.md) - Learn how actions use contracts
- [CQRS and Read Models](./11-cqrs-and-read-models.md) - Learn about the Repository pattern
- [Infrastructure](./07-infrastructure.md) - Learn how to implement contracts
