---
title: Testing
description: "Testing strategy across layers: Entity (unit), Action (integration with fakes), Infrastructure (integration), API (E2E)."
sidebar_position: 16
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Testing

[← Back to README](./README.md)

---

## Testing Strategy

| Layer | Test Type | Dependencies |
|-------|-----------|--------------|
| Entity | Unit test | None |
| Action | Integration test | Fakes |
| Infrastructure | Integration test | Real systems (optional) |
| API | E2E test | Full stack |

---

## Testing Domain Objects (No Dependencies)

Entities have no external dependencies - easy to unit test:

```typescript
// packages/core/src/orders/Order.test.ts
import { Order } from './Order';
import { InvariantError } from '../shared/errors';

describe('Order', () => {
  describe('submit', () => {
    it('submits order with items', () => {
      const order = new Order('1', 'customer-1', [{ productId: 'p1', quantity: 2, price: 10 }]);
      order.submit();
      expect(order.status).toBe('submitted');
    });

    it('throws InvariantError when order is empty', () => {
      const order = new Order('1', 'customer-1', []);
      expect(() => order.submit()).toThrow(InvariantError);
    });
  });

  describe('cancel', () => {
    it('cancels submitted order', () => {
      const order = new Order('1', 'customer-1', [], 'submitted');
      order.cancel('changed mind');
      expect(order.status).toBe('cancelled');
      expect(order.cancelReason).toBe('changed mind');
    });

    it('throws InvariantError when order is shipped', () => {
      const order = new Order('1', 'customer-1', [], 'shipped');
      expect(() => order.cancel('reason')).toThrow(InvariantError);
    });
  });

  describe('total', () => {
    it('calculates total from items', () => {
      const order = new Order('1', 'customer-1', [
        { productId: 'p1', quantity: 2, price: 10 },
        { productId: 'p2', quantity: 1, price: 25 }
      ]);
      expect(order.total).toBe(45);
    });
  });
});
```

---

## Testing Actions (With Fakes)

Create simple fake implementations - no mocking library needed:

```typescript
// packages/core/test/fakes.ts
export class FakeOrderRepository implements OrderRepository {
  public orders: Map<string, Order> = new Map();

  async save(order: Order) { this.orders.set(order.id, order); }
  async findById(id: string) { return this.orders.get(id) || null; }
  async findByCustomer(customerId: string) {
    return Array.from(this.orders.values()).filter(o => o.customerId === customerId);
  }
  clear() { this.orders.clear(); }
}

export class FakeMailer implements Mailer {
  public sentEmails: Array<{ to: string; subject: string; body: string }> = [];

  async send(to: string, subject: string, body: string) {
    this.sentEmails.push({ to, subject, body });
  }
  clear() { this.sentEmails = []; }
  getLastEmail() { return this.sentEmails[this.sentEmails.length - 1]; }
}

// Auth context helpers
export function createTestContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return { userId: 'test-user', roles: ['customer'], isAdmin: false, ...overrides };
}

export function createAdminContext(): AuthContext {
  return { userId: 'admin-user', roles: ['admin'], isAdmin: true };
}
```

### Action Test Example

```typescript
// packages/core/src/orders/actions/createOrder.test.ts
import { createOrder } from './createOrder';
import { FakeOrderRepository, FakeMailer, createTestContext } from '../../../test/fakes';

describe('createOrder', () => {
  let repository: FakeOrderRepository;
  let mailer: FakeMailer;
  let ctx: AuthContext;

  beforeEach(() => {
    repository = new FakeOrderRepository();
    mailer = new FakeMailer();
    ctx = createTestContext();
  });

  it('creates and persists order', async () => {
    const order = await createOrder(
      { repository, mailer },
      ctx,
      { customerId: 'c1', email: 'test@example.com', items: [{ productId: 'p1', quantity: 2, price: 10 }] }
    );

    expect(order.status).toBe('submitted');
    expect(order.total).toBe(20);
    expect(await repository.findById(order.id)).toEqual(order);
  });

  it('sends confirmation email', async () => {
    await createOrder(
      { repository, mailer },
      ctx,
      { customerId: 'c1', email: 'test@example.com', items: [{ productId: 'p1', quantity: 1, price: 50 }] }
    );

    expect(mailer.sentEmails).toHaveLength(1);
    expect(mailer.sentEmails[0].to).toBe('test@example.com');
  });

  it('throws when items are empty', async () => {
    await expect(
      createOrder({ repository, mailer }, ctx, { customerId: 'c1', email: 'test@example.com', items: [] })
    ).rejects.toThrow('Cannot submit empty order');
  });
});
```

---

## Testing System Actions

System actions have no `ctx` parameter:

```typescript
// packages/core/src/orders/actions/systemExpireStaleOrders.test.ts
describe('systemExpireStaleOrders', () => {
  it('expires orders older than specified days', async () => {
    const staleOrder = new Order('1', 'c1', [{ productId: 'p1', quantity: 1, price: 10 }], 'submitted');
    repository.addStale(staleOrder, 10);

    const expiredCount = await systemExpireStaleOrders(
      { repository, mailer },
      { olderThanDays: 7 }  // No ctx parameter
    );

    expect(expiredCount).toBe(1);
    expect(staleOrder.status).toBe('cancelled');
  });
});
```

---

## Testing Error Cases

```typescript
// packages/core/src/orders/actions/cancelOrder.test.ts
import { NotFoundError, BusinessError, InvariantError } from '../../shared/errors';

describe('cancelOrder', () => {
  it('throws NotFoundError when order does not exist', async () => {
    await expect(
      cancelOrder({ repository, mailer }, ctx, { orderId: 'non-existent', email: 'x@y.com', reason: 'r' })
    ).rejects.toThrow(NotFoundError);
  });

  it('throws BusinessError when user is not authorized', async () => {
    const order = new Order('1', 'other-customer', [], 'submitted');
    await repository.save(order);

    await expect(
      cancelOrder({ repository, mailer }, ctx, { orderId: '1', email: 'x@y.com', reason: 'r' })
    ).rejects.toThrow(BusinessError);
  });

  it('throws InvariantError when order is shipped', async () => {
    const order = new Order('1', 'test-user', [], 'shipped');
    await repository.save(order);

    await expect(
      cancelOrder({ repository, mailer }, ctx, { orderId: '1', email: 'x@y.com', reason: 'r' })
    ).rejects.toThrow(InvariantError);
  });

  it('does not send email when cancellation fails', async () => {
    const order = new Order('1', 'test-user', [], 'shipped');
    await repository.save(order);

    try { await cancelOrder({ repository, mailer }, ctx, { orderId: '1', email: 'x@y.com', reason: 'r' }); }
    catch (e) { /* Expected */ }

    expect(mailer.sentEmails).toHaveLength(0);
  });
});
```

---

## Testing with Function Dependencies

Function dependencies make testing trivial - just pass inline functions:

```typescript
describe('createOrder with cross-feature deps', () => {
  function createTestDeps(overrides: Partial<CreateOrderDeps> = {}): CreateOrderDeps {
    return {
      repository: new FakeOrderRepository(),
      mailer: new FakeMailer(),
      getCustomer: async (id) => ({
        id, name: 'Test', email: 'test@example.com', isInGoodStanding: true, creditLimit: 1000,
      }),
      ...overrides,
    };
  }

  it('throws when customer not found', async () => {
    const deps = createTestDeps({ getCustomer: async () => null });
    await expect(createOrder(deps, ctx, input)).rejects.toThrow('Customer not found');
  });

  it('throws when customer is suspended', async () => {
    const deps = createTestDeps({
      getCustomer: async (id) => ({ id, name: 'X', email: 'x@y.com', isInGoodStanding: false, creditLimit: 1000 }),
    });
    await expect(createOrder(deps, ctx, input)).rejects.toThrow('not in good standing');
  });
});
```

---

## Test Organization

```
packages/
|- core/
|   |- src/
|   |   +- orders/
|   |       |- Order.ts
|   |       |- Order.test.ts              # Unit tests
|   |       +- actions/
|   |           |- createOrder.ts
|   |           +- createOrder.test.ts    # Integration tests
|   |
|   +- test/
|       +- fakes.ts                       # Shared test fakes
|
+- infra/
    +- src/
        +- orders/
            |- OrderRepositoryMongo.ts
            +- OrderRepositoryMongo.test.ts  # Optional integration tests
```

---

## Testing Transactions

```typescript
// Quick reference: FakeTransactionManager
export class FakeTransactionManager implements TransactionManager {
  public runCount = 0;
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.runCount++;
    return work();
  }
}

// Usage
it('wraps operations in a transaction', async () => {
  const tx = new FakeTransactionManager();
  await createOrder({ tx, repository, mailer }, ctx, input);
  expect(tx.runCount).toBe(1);
});
```

---

## Benefits

| Benefit | How |
|---------|-----|
| **Fast tests** | Entities have no I/O |
| **No mocking library** | Simple fake implementations |
| **Reliable** | Fakes implement real interfaces |
| **Maintainable** | Fakes update when contracts change |

---

## Next Steps

- [Domain Objects](./03-domain-objects.md) - What to test in entities
- [Actions](./05-actions.md) - What to test in actions
