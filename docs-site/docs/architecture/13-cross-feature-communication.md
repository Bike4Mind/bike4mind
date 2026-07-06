---
title: Cross-Feature Communication
description: Features are isolated, but sometimes Feature A needs data from Feature B — use function dependencies to avoid coupling.
sidebar_position: 14
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Cross-Feature Communication

[← Back to README](./README.md)

---

## The Problem

Features are isolated, but sometimes **Feature A needs data from Feature B**. The naive solution creates coupling:

```typescript
// Bad: orders/ depends on customers/ internals
import { CustomerRepository } from '../../customers/CustomerRepository';

export interface CreateOrderDeps {
  customerRepository: CustomerRepository;  // Tight coupling!
}
```

| Issue | Problem |
|-------|---------|
| Coupling | `orders/` knows `customers/` internal structure |
| Ripple effects | `CustomerRepository` changes break `orders/` |
| Testing complexity | Need `CustomerRepository` fakes |
| Unclear boundaries | Hard to see what `orders/` actually needs |

**Goal**: Features collaborate without knowing each other's internals.

---

## The Solution: Function Dependencies

Instead of importing repositories, **depend on a function signature**. This works for both **reading** and **writing** cross-feature data:

```typescript
// Good: orders/ defines what it needs
export interface CustomerData {
  id: string;
  name: string;
  email: string;
  isInGoodStanding: boolean;
}

export interface QuestUpdateData {
  status: 'stopped' | 'error';
  replies: string[];
}

export interface CreateOrderDeps {
  orderRepository: OrderRepository;
  mailer: Mailer;
  // READ from another feature
  getCustomer: (customerId: string) => Promise<CustomerData | null>;
  // WRITE to another feature - equally valid!
  updateQuest: (questId: string, data: QuestUpdateData) => Promise<void>;
}
```

| Before | After |
|--------|-------|
| `customerRepository: CustomerRepository` | `getCustomer: (id) => Promise<CustomerData \| null>` |
| `questRepository: QuestRepository` | `updateQuest: (id, data) => Promise<void>` |
| Imports from other features | No cross-feature imports |
| Knows other feature's entities | Only knows minimal data interfaces |

---

## Benefits

| Benefit | How |
|---------|-----|
| **No cross-feature imports** | Wiring happens in entry points only |
| **Minimal interface** | Define exactly what you need |
| **Easy to test** | Inline functions as mocks |
| **Clear boundaries** | Function signature documents dependency |

---

## Example: createOrder Action

```typescript
// packages/core/src/orders/actions/createOrder.ts

// Define what we NEED (not what customers/ provides)
export interface CustomerData {
  id: string;
  name: string;
  email: string;
  isInGoodStanding: boolean;
  creditLimit: number;
}

export interface CreateOrderDeps {
  orderRepository: OrderRepository;
  mailer: Mailer;
  getCustomer: (customerId: string) => Promise<CustomerData | null>;
}

export async function createOrder(
  deps: CreateOrderDeps,
  ctx: AuthContext,
  input: CreateOrderInput
): Promise<Order> {
  const customer = await deps.getCustomer(input.customerId);
  if (!customer) throw new NotFoundError('Customer not found');
  if (!customer.isInGoodStanding) throw new BusinessError('Customer not in good standing');

  const total = input.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  if (total > customer.creditLimit) throw new BusinessError('Order exceeds credit limit');

  const order = new Order(crypto.randomUUID(), input.customerId, input.items);
  order.submit();
  await deps.orderRepository.save(order);
  await deps.mailer.send(customer.email, 'Order Confirmed', `Order #${order.id} placed.`);

  return order;
}
```

**No imports from `customers/`** - `CustomerData` is defined by `orders/`.

---

## Wiring in Entry Points

Connect features at the entry point:

```typescript
// apps/client/pages/api/orders/index.ts
import { baseApi } from '@server/middlewares/baseApi';
import { createOrder } from '@packages/core/orders';
import { getCustomer } from '@packages/core/customers';
import { OrderRepositoryMongo } from '@packages/infra/orders/OrderRepositoryMongo';
import { CustomerRepositoryMongo } from '@packages/infra/customers/CustomerRepositoryMongo';
import { SendGridMailer } from '@packages/infra/shared/email/SendGridMailer';

const orderRepository = new OrderRepositoryMongo();
const customerRepository = new CustomerRepositoryMongo();
const mailer = new SendGridMailer(process.env.SENDGRID_API_KEY!, 'orders@myapp.com');

const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const deps = {
      orderRepository,
      mailer,
      getCustomer: async (customerId: string) => {
        const customer = await getCustomer(
          { repository: customerRepository },
          req.ctx,
          { customerId }
        );
        if (!customer) return null;
        return {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          isInGoodStanding: customer.isInGoodStanding(),
          creditLimit: customer.creditLimit,
        };
      },
    };

    const order = await createOrder(deps, req.ctx, req.body);
    res.status(201).json({ id: order.id });
  });

export default handler;
```

**Key points:**
1. Factory pattern: bind auth context in handler
2. Mapping layer: Converts `Customer` entity to `CustomerData`
3. Single location: All cross-feature wiring visible in one place

---

## Dependency Variations

| Situation | Pattern |
|-----------|---------|
| 1-2 simple functions | Inline function types |
| Reused across 3+ actions | Named function types |
| 3+ functions from same feature | Grouped service object |

### Read vs Write Function Dependencies

Function dependencies work for both reading and writing cross-feature data:

| Type | Purpose | Example |
|------|---------|---------|
| **Read** | Get data from another feature | `getCustomer: (id) => Promise<CustomerData \| null>` |
| **Write** | Update data in another feature | `updateQuest: (id, data) => Promise<void>` |

Both patterns follow the same rules:
- Function is injected via `deps` (not imported directly)
- Local types are defined for input/output data
- The action has no knowledge of the implementation

### Inline (1-2 functions)

```typescript
export interface CreateOrderDeps {
  // Read functions
  getCustomer: (customerId: string) => Promise<CustomerData | null>;
  checkStock: (productId: string, quantity: number) => Promise<boolean>;
  // Write functions
  updateQuest: (questId: string, data: QuestUpdateData) => Promise<void>;
}
```

### Named (reused across actions)

```typescript
// packages/core/src/orders/dependencies.ts
export type GetCustomerFn = (customerId: string) => Promise<CustomerData | null>;
export type UpdateQuestFn = (questId: string, data: QuestUpdateData) => Promise<void>;

// In actions
export interface CreateOrderDeps { getCustomer: GetCustomerFn; updateQuest: UpdateQuestFn; }
export interface CancelOrderDeps { getCustomer: GetCustomerFn; }
```

### Grouped (3+ functions from same feature)

```typescript
export interface InventoryService {
  // Read
  checkStock: (productId: string, qty: number) => Promise<StockCheckResult>;
  // Write
  reserveStock: (orderId: string, items: ReserveItem[]) => Promise<void>;
  releaseStock: (orderId: string) => Promise<void>;
}

export interface CreateOrderDeps {
  inventory: InventoryService;
}
```

---

## Testing

Function dependencies make testing trivial - just pass inline functions:

```typescript
describe('createOrder', () => {
  function createTestDeps(overrides: Partial<CreateOrderDeps> = {}): CreateOrderDeps {
    return {
      orderRepository: new FakeOrderRepository(),
      mailer: new FakeMailer(),
      getCustomer: async (id) => ({
        id, name: 'Test', email: 'test@example.com',
        isInGoodStanding: true, creditLimit: 1000,
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
      getCustomer: async (id) => ({ id, name: 'Suspended', email: 'x@y.com', isInGoodStanding: false, creditLimit: 1000 }),
    });
    await expect(createOrder(deps, ctx, input)).rejects.toThrow('not in good standing');
  });
});
```

**No `FakeCustomerRepository` needed** - inline functions for each scenario.

See [Testing](./15-testing.md) for more patterns.

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Importing repositories directly | Use function dependencies |
| Passing full entities | Define minimal data interface |
| Forgetting null checks | Always handle `null` returns |

```typescript
// Bad: imports Customer entity
import { Customer } from '../../customers/Customer';
getCustomer: (id: string) => Promise<Customer | null>;

// Good: defines minimal interface
interface CustomerData { id: string; name: string; isInGoodStanding: boolean; }
getCustomer: (id: string) => Promise<CustomerData | null>;
```

---

## Summary

1. **Define what you need** as a function type in the consuming feature
2. **Both read AND write** function dependencies are valid
3. **No cross-feature imports** in core - wiring in entry points
4. **Pass auth context through** via factory functions
5. **Easy to test** with inline function mocks

```typescript
// The pattern - supports both read and write
export interface CreateOrderDeps {
  orderRepository: OrderRepository;                           // Own feature's contract
  getCustomer: (id: string) => Promise<CustomerData | null>;  // Read from another feature
  updateQuest: (id: string, data: QuestUpdate) => Promise<void>;  // Write to another feature
}
```

---

## Next Steps

- [Actions](./05-actions.md) - Action patterns
- [Contracts](./04-contracts.md) - Shared contracts across features
- [Testing](./15-testing.md) - Testing strategies
