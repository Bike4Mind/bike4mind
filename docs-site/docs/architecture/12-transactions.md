---
title: Transactions
description: How to save multiple things atomically with all-or-nothing behavior while maintaining feature isolation.
sidebar_position: 13
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Transactions

[← Back to README](./README.md)

---

## The Challenge

Actions often need to save multiple things atomically:

```typescript
// What if inventory reservation fails after order is saved?
async function createOrder(deps, ctx, input) {
  await deps.orderRepository.save(order);        // Saved
  await deps.reserveStock(order.id, items);      // Failed - now inconsistent!
}
```

We need all-or-nothing behavior while maintaining [feature isolation](./13-cross-feature-communication.md).

---

## Strategy: Ambient Transactions

This architecture uses **ambient transactions** - repositories automatically detect and use an active transaction without callers passing it explicitly.

```
tx.run(async () => {
  AsyncLocalStorage holds the transaction session

  await deps.repository.save(order)
       -> getSession() checks context -> uses txSession

  await deps.reserveStock(orderId, items)
       -> inventoryRepo.reserve(...)
            -> getSession() checks context -> uses txSession
})
```

**Key benefits:**
- Function dependencies stay clean (no `tx` parameter)
- Actions don't know which repositories participate
- Familiar pattern (Spring `@Transactional`, .NET `TransactionScope`)

---

## The Contract

```typescript
// packages/core/src/shared/TransactionManager.ts
export interface TransactionManager {
  run<T>(work: () => Promise<T>): Promise<T>;
}
```

Wrap work in `tx.run()`, and all database operations inside automatically participate.

---

## Using Transactions in Actions

```typescript
// packages/core/src/orders/actions/createOrder.ts
export interface CreateOrderDeps {
  tx: TransactionManager;
  repository: OrderRepository;
  mailer: Mailer;
  getCustomer: (customerId: string) => Promise<CustomerData | null>;
  reserveStock: (orderId: string, productId: string, quantity: number) => Promise<boolean>;
}

export async function createOrder(
  deps: CreateOrderDeps,
  ctx: AuthContext,
  input: CreateOrderInput
): Promise<Order> {
  // 1. Authorize (before transaction)
  if (!OrderPolicies.canCreate(ctx)) {
    throw new BusinessError('Not authorized to create orders');
  }

  // 2. Everything inside runs in a transaction
  const { order, customer } = await deps.tx.run(async () => {
    const customer = await deps.getCustomer(input.customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    if (!customer.isInGoodStanding) {
      throw new BusinessError('Customer account is not in good standing');
    }

    const order = new Order(crypto.randomUUID(), input.customerId, input.items);
    order.submit();
    await deps.repository.save(order);

    for (const item of order.items) {
      const reserved = await deps.reserveStock(order.id, item.productId, item.quantity);
      if (!reserved) throw new BusinessError(`Insufficient stock for ${item.productId}`);
    }

    return { order, customer };
  });

  // 3. Side effects AFTER transaction commits
  await deps.mailer.send(customer.email, 'Order Confirmed', `Order #${order.id} placed.`);

  return order;
}
```

Function dependencies (`getCustomer`, `reserveStock`) automatically participate in the transaction.

---

## Implementation

### Transaction Context (AsyncLocalStorage)

```typescript
// packages/infra/src/shared/mongodb/TransactionContext.ts
import { AsyncLocalStorage } from 'async_hooks';
import { ClientSession, Connection } from 'mongoose';

export const transactionContext = new AsyncLocalStorage<ClientSession>();

export function getCurrentSession(): ClientSession | undefined {
  return transactionContext.getStore();
}
```

### Transaction Manager

```typescript
// packages/infra/src/shared/mongodb/MongoTransactionManager.ts
import { Connection } from 'mongoose';
import { TransactionManager } from '@packages/core/shared/TransactionManager';
import { transactionContext } from './TransactionContext';

export class MongoTransactionManager implements TransactionManager {
  constructor(private connection: Connection) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let result: T;
      await session.withTransaction(async () => {
        result = await transactionContext.run(session, work);
      });
      return result!;
    } finally {
      await session.endSession();
    }
  }
}
```

### Base Repository

All repositories extend this to auto-detect active transactions:

```typescript
// packages/infra/src/shared/mongodb/BaseMongoRepository.ts
import { Model, ClientSession } from 'mongoose';
import { getCurrentSession } from './TransactionContext';

export abstract class BaseMongoRepository<T> {
  constructor(protected model: Model<T>) {}

  protected get session(): ClientSession | undefined {
    return getCurrentSession();
  }

  // Use this.session in all operations to automatically use transaction if active
  protected async saveWithSession(doc: T): Promise<void> {
    await this.model.create([doc], { session: this.session });
  }
}
```

Repository implementations use `this.session` for all queries - automatically uses transaction if active.

---

## When to Use Transactions

| Use `tx.run()` When | Don't Use When |
|---------------------|----------------|
| Multiple writes must succeed/fail together | Single write operation (already atomic) |
| Cross-feature writes need atomicity | Read-only queries |
| Read-then-write must be consistent | Side effects (email, webhooks) |
| | Long-running operations (holds locks) |

### Guidelines

```typescript
// Good: Multiple related writes
const order = await deps.tx.run(async () => {
  await deps.repository.save(order);
  await deps.reserveStock(order.id, items);
  return order;
});

// Good: Side effects after transaction
const order = await deps.tx.run(async () => {
  await deps.repository.save(order);
  return order;
});
await deps.mailer.send(...);  // After commit

// Bad: Side effects inside transaction
await deps.tx.run(async () => {
  await deps.repository.save(order);
  await deps.mailer.send(...);  // Rolls back order if email fails
});

// Bad: Single operation (unnecessary overhead)
await deps.tx.run(async () => {
  await deps.repository.save(order);  // Just do: await deps.repository.save(order)
});
```

---

## Key Principles

| Principle | Description |
|-----------|-------------|
| **Side Effects After** | Email, webhooks happen after `tx.run()` completes |
| **Keep It Short** | Only database operations inside transaction |
| **Auth Before** | Check permissions before starting transaction |

---

## Testing

See [Testing](./15-testing.md) for `FakeTransactionManager` and testing patterns.

```typescript
// Quick reference: FakeTransactionManager
export class FakeTransactionManager implements TransactionManager {
  public runCount = 0;
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.runCount++;
    return work();
  }
}
```

---

## Summary

| Concept | Description |
|---------|-------------|
| **Ambient Transactions** | Repositories auto-detect via `AsyncLocalStorage` |
| **Clean Dependencies** | Cross-feature calls don't need `tx` parameter |
| **Side Effects After** | Email, webhooks after commit |
| **Keep It Short** | Only DB operations inside `tx.run()` |

---

## Next Steps

- [Actions](./05-actions.md) - Action patterns
- [Cross-Feature Communication](./13-cross-feature-communication.md) - Function dependencies
- [Testing](./15-testing.md) - Testing with fakes
