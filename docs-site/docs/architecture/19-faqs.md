---
title: Frequently Asked Questions
description: Answers to common questions about domain objects, actions, contracts, and the architecture patterns.
sidebar_position: 20
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Frequently Asked Questions

[← Back to README](./README.md)

---

## Table of Contents

<!-- TOC: Add new entries here as FAQs grow -->

### Domain & Entities
- [Why not put entity interfaces in shared/?](#why-not-put-entity-interfaces-in-shared)
- [When can you share an interface between entity and frontend?](#when-can-you-share-an-interface-between-entity-and-frontend)

### Actions
- [Why can't my entity method be async?](#why-cant-my-entity-method-be-async)
- [Do I need to check permissions in every action?](#do-i-need-to-check-permissions-in-every-action)
- [Does my system action need AuthContext?](#does-my-system-action-need-authcontext)
- [When do I throw NotFoundError vs BusinessError?](#when-do-i-throw-notfounderror-vs-businesserror)

### Infrastructure
- [Why can't I import pg in my action?](#why-cant-i-import-pg-in-my-action)
- [Can I import CustomerRepository in my orders feature?](#can-i-import-customerrepository-in-my-orders-feature)
- [Can I import UserRepositoryPostgres in OrderRepositoryPostgres?](#can-i-import-userrepositorypostgres-in-orderrepositorypostgres)
- [Can I create a new Pool() in my handler?](#can-i-create-a-new-pool-in-my-handler)

### Handlers & API
- [Can I put database queries in my handler?](#can-i-put-database-queries-in-my-handler)
- [Can shared package import from core?](#can-shared-package-import-from-core)

### Testing
<!-- Add testing-related FAQs here -->

---

## Domain & Entities

### Why not put entity interfaces in shared/?

**Question:** What if I added an `IOrder` interface in `shared/`, then have the core entity implement `IOrder`? The frontend could use the interface for typing.

**Short answer:** It creates coupling problems because entity shape and API response shape are usually different.

**The problem: Entity internals ≠ API contract**

```typescript
// What you might propose (shared/)
interface IOrder {
  id: string;
  status: string;
  total: number;
  customerId: string;
}

// But your entity often has more/different things
class Order implements IOrder {
  id: string;
  status: string;
  customerId: string;

  // Internal state - not for frontend
  private _lineItems: LineItem[];
  private _version: number;

  // Computed property - doesn't serialize to JSON
  get total(): number {
    return this._lineItems.reduce((sum, item) => sum + item.price, 0);
  }

  // Methods the frontend doesn't need
  submit(): void { /* ... */ }
  cancel(): void { /* ... */ }
}
```

**Common mismatches between entities and API responses:**

| Entity | API Response |
|--------|--------------|
| `createdAt: Date` | `createdAt: string` (ISO format) |
| `_internalField` | omitted entirely |
| `get computed()` | serialized as plain value |
| Nested entity objects | Flattened or partially included |
| Circular references | Broken/omitted |

**If you force them to share an interface, you either:**

1. **Expose internal details to frontend** - Leaking implementation concerns
2. **Constrain entity design** - Can't add internal state without updating the shared interface

**The recommended approach:**

```
core/Order.ts           → Full entity with behavior
shared/api-types/       → OrderResponse, CreateOrderInput (explicit API contract)
handlers/               → Map entity → response DTO
```

This gives you freedom to evolve entity internals without breaking the API contract.

---

### When can you share an interface between entity and frontend?

**Short answer:** When the type is purely structural with no behavior, computed properties, or internal state.

**Example 1: Enums and constants**

```typescript
// shared/constants/orderStatuses.ts
export const OrderStatus = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;

export type OrderStatus = typeof OrderStatus[keyof typeof OrderStatus];
```

Both frontend and backend can use this. It's just data, no behavior.

**Example 2: Simple value objects**

```typescript
// shared/types/address.ts
export interface Address {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}
```

This works because:
- No methods or computed properties
- No internal state
- Serializes to JSON identically
- Same shape in DB, API, and frontend

**Example 3: Calculation results**

```typescript
// shared/types/pricing.ts
export interface PriceBreakdown {
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
}
```

Pure data representing a calculation result. No behavior attached.

**Rule of thumb:** Purely structural (just a shape) → `shared/`. Any logic → `core/`.

---

## Actions

### Why can't my entity method be async?

**Short answer:** Entities shouldn't have side effects. Async operations imply I/O which belongs in actions.

**The problem:**

```typescript
// ❌ Bad - entity with async method
class Order {
  async submit() {
    this.status = 'submitted';
    await sendEmail(this.customerEmail, 'Confirmed');  // Side effect!
  }
}
```

**Why this violates the architecture:**
- Entities represent domain state and business rules
- Side effects (email, logging, external calls) are infrastructure concerns
- Async methods make entities harder to test
- Mixing I/O with state makes behavior unpredictable

**The fix:** Move async operations to actions, keep entities synchronous:

```typescript
// ✅ Good - entity is synchronous
class Order {
  submit(): void {
    if (this.status !== 'draft') {
      throw new InvariantError('Only draft orders can be submitted');
    }
    this.status = 'submitted';
  }
}

// Action handles side effects
async function submitOrder(deps, ctx, input) {
  const order = await deps.repository.findById(input.orderId);
  order.submit();  // Synchronous state change
  await deps.repository.save(order);
  await deps.mailer.send(order.customerEmail, 'Order Confirmed', '...');  // Side effect here
}
```

**Rule of thumb:** If it needs `await`, it goes in an Action.

See [Anti-Pattern AP-3](./08-rules-and-guidelines.md#ap-3-side-effects-in-entity) for detection patterns.

---

### Do I need to check permissions in every action?

**Short answer:** Yes, every user action needs a policy check after loading the entity.

**Why it matters:**
- Authorization is a cross-cutting concern that must be explicit
- Missing checks create security vulnerabilities
- Policies document who can do what

**The pattern:**

```typescript
export async function cancelOrder(deps, ctx, input) {
  // 1. Load
  const order = await deps.repository.findById(input.orderId);
  if (!order) throw new NotFoundError('Order', input.orderId);

  // 2. Authorize - REQUIRED for user actions
  if (!OrderPolicies.canCancel(ctx, order)) {
    throw new BusinessError('Not authorized to cancel this order');
  }

  // 3. Execute
  order.cancel(input.reason);
  await deps.repository.save(order);
}
```

**Exception:** System actions (prefixed with `system`) don't have AuthContext and skip authorization. They're called by internal processes, not users.

See [Anti-Pattern AP-4](./08-rules-and-guidelines.md#ap-4-missing-authorization-check) for detection patterns.

---

### Does my system action need AuthContext?

**Short answer:** No. System actions have signature `(deps, input)` without `ctx`.

**User actions vs System actions:**

| Type | Signature | Called By | Has AuthContext |
|------|-----------|-----------|-----------------|
| User action | `(deps, ctx, input)` | API handlers, CLI | Yes |
| System action | `(deps, input)` | Workers, schedulers, migrations | No |

**Example:**

```typescript
// User action - called by authenticated users
export async function cancelOrder(
  deps: CancelOrderDeps,
  ctx: AuthContext,        // ← Has auth context
  input: CancelOrderInput
): Promise<void>

// System action - called by scheduler/worker
export async function systemExpireOrders(
  deps: ExpireOrdersDeps,
  input: ExpireOrdersInput  // ← No auth context
): Promise<number>
```

**Why the difference:**
- System actions run as the system, not as a user
- No user session exists for background jobs
- Authorization is implicit (the system is trusted)

See [Anti-Pattern AP-7](./08-rules-and-guidelines.md#ap-7-action-signature-violation) for signature rules.

---

### When do I throw NotFoundError vs BusinessError?

**Short answer:** NotFoundError for missing resources, BusinessError for rule violations.

| Error Type | HTTP Status | When to Use | Thrown By |
|------------|-------------|-------------|-----------|
| `NotFoundError` | 404 | Resource doesn't exist in database | Action |
| `BusinessError` | 422 | Business rule prevents the operation | Action |
| `InvariantError` | 422 | Invalid state transition attempted | Entity only |

**Examples:**

```typescript
async function cancelOrder(deps, ctx, input) {
  const order = await deps.repository.findById(input.orderId);

  // NotFoundError - resource doesn't exist
  if (!order) {
    throw new NotFoundError('Order', input.orderId);
  }

  // BusinessError - business rule prevents action
  if (order.hasShipped()) {
    throw new BusinessError('Cannot cancel an order that has already shipped');
  }

  order.cancel();  // May throw InvariantError internally
  await deps.repository.save(order);
}
```

**Common mistakes:**
- Using NotFoundError for permission denied (use BusinessError)
- Using BusinessError for validation errors (use input validation in handler)
- Throwing InvariantError in actions (only entities should throw this)

See [Anti-Pattern AP-6](./08-rules-and-guidelines.md#ap-6-wrong-error-type) for correct usage.

---

## Infrastructure

### Why can't I import pg in my action?

**Short answer:** Core cannot import infrastructure. Create a repository contract instead.

**The problem:**

```typescript
// ❌ Bad - packages/core/src/orders/actions/createOrder.ts
import { Pool } from 'pg';  // VIOLATION!

export async function createOrder(deps, ctx, input) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('INSERT INTO orders...');
}
```

**Why this violates the architecture:**
- Core should know nothing about databases, HTTP, or external systems
- Direct imports couple your business logic to specific technologies
- Makes testing require real database connections or complex mocking
- Prevents swapping implementations (Postgres → MySQL, or in-memory for tests)

**The fix:** Define a contract interface in core, implement in infra:

```typescript
// packages/core/src/orders/OrderRepository.ts (contract)
export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
}

// packages/infra/src/orders/OrderRepositoryMongo.ts (implementation)
import { Collection } from 'mongodb';
import { OrderRepository } from '@packages/core/orders';

export class OrderRepositoryMongo implements OrderRepository {
  constructor(private collection: Collection) {}
  // ... implementation
}
```

See [Anti-Pattern AP-1](./08-rules-and-guidelines.md#ap-1-infrastructure-import-in-core) for detection patterns.

---

### Can I import CustomerRepository in my orders feature?

**Short answer:** No. Use function dependencies instead.

**The problem:**

```typescript
// ❌ Bad - packages/core/src/orders/actions/createOrder.ts
import { CustomerRepository } from '../../customers/CustomerRepository';  // Cross-feature import!
```

**Why this violates the architecture:**
- Creates tight coupling between features
- Makes features harder to test in isolation
- Prevents features from evolving independently
- Can lead to circular dependencies

**The fix:** Use function dependencies for both reading AND writing:

```typescript
// ✅ Good - use function dependencies
interface CustomerData {
  id: string;
  email: string;
  isInGoodStanding: boolean;
}

export interface CreateOrderDeps {
  repository: OrderRepository;
  // Read from another feature
  getCustomer: (customerId: string) => Promise<CustomerData | null>;
  // Write to another feature - also valid!
  updateQuest: (questId: string, data: QuestUpdateData) => Promise<void>;
}

export async function createOrder(deps, ctx, input) {
  const customer = await deps.getCustomer(input.customerId);
  if (!customer) throw new NotFoundError('Customer', input.customerId);
  // ...
}
```

Wire the function dependency in `main.ts`:

```typescript
// apps/server/src/main.ts
const createOrderDeps = (ctx: AuthContext) => ({
  repository: orderRepository,
  getCustomer: async (id) => {
    const c = await getCustomer(customerDeps, ctx, { customerId: id });
    return c ? { id: c.id, email: c.email, isInGoodStanding: c.status === 'active' } : null;
  },
});
```

See [Anti-Pattern AP-5](./08-rules-and-guidelines.md#ap-5-cross-feature-repository-import) and [Cross-Feature Communication](./13-cross-feature-communication.md).

---

### Can I import UserRepositoryPostgres in OrderRepositoryPostgres?

**Short answer:** No. Feature infra can only import from same feature or `infra/shared`.

**The problem:**

```typescript
// ❌ Bad - packages/infra/src/orders/OrderRepositoryMongo.ts
import { UserRepositoryMongo } from '../users/UserRepositoryMongo';  // Cross-feature infra import!
```

**Allowed imports for feature infra:**

| Can Import From | Example |
|-----------------|---------|
| `@packages/core` | Contracts, domain objects |
| `@packages/infra/shared` | Base classes, utilities, shared connections |
| Same feature folder | Other files in `infra/orders/` |

**Why:**
- Cross-feature infra imports create hidden coupling
- Each feature's infra should be self-contained
- Shared utilities belong in `infra/shared/`

**If you need shared database logic:**

```typescript
// packages/infra/src/shared/mongodb/BaseMongoRepository.ts
export abstract class BaseMongoRepository<T> {
  constructor(protected collection: Collection<T>) {}

  protected async findOneById(id: string): Promise<T | null> {
    return this.collection.findOne({ _id: new ObjectId(id) });
  }
}
```

See [Anti-Pattern AP-5b](./08-rules-and-guidelines.md#ap-5b-cross-feature-infra-import).

---

### Can I create a new Pool() in my handler?

**Short answer:** No. Wire dependencies in `main.ts`, inject into handlers.

**The problem:**

```typescript
// ❌ Bad - apps/server/src/api/handlers/orderHandlers.ts
export async function createOrderHandler(req, res) {
  const db = new MongoClient(process.env.MONGODB_URI);                   // VIOLATION
  const repository = new OrderRepositoryMongo(db.collection('orders'));  // VIOLATION
  const mailer = new SendGridMailer(process.env.SENDGRID_KEY);           // VIOLATION

  const order = await createOrder({ repository, mailer }, req.ctx, req.body);
  res.json(order);
}
```

**Problems with this approach:**

| Issue | Impact |
|-------|--------|
| Connection pool per request | DB connection exhaustion under load |
| No singleton guarantees | Duplicated expensive resources |
| Testing difficulty | Can't inject fakes without module mocking |
| Fail on first request | Bad config discovered at runtime, not startup |

**The fix:** Wire once at startup, inject into handlers:

```typescript
// apps/server/src/main.ts
const db = new MongoClient(process.env.MONGODB_URI);
const repository = new OrderRepositoryMongo(db.collection('orders'));
const mailer = new SendGridMailer(process.env.SENDGRID_KEY);
const deps = { repository, mailer };

app.use('/api/orders', createOrderRoutes(deps));  // ✅ Inject deps

// apps/server/src/api/handlers/orderHandlers.ts
export function createOrderHandler(deps: OrderDeps) {
  return async (req, res, next) => {
    const order = await createOrder(deps, req.ctx, req.body);
    res.json(order);
  };
}
```

See [Anti-Pattern AP-9](./08-rules-and-guidelines.md#ap-9-wiring-dependencies-in-handlers) and [Entry Points - Wiring](./06-entry-points.md#wiring-dependencies-in-maints).

---

## Handlers & API

### Can I put database queries in my handler?

**Short answer:** No. Handlers only validate input and call actions.

**The problem:**

```typescript
// ❌ Bad - apps/server/src/api/handlers/orderHandlers.ts
app.post('/orders', async (req, res) => {
  const customer = await db.collection('customers').findOne({ _id: req.body.customerId });
  if (customer.status === 'suspended') {  // Business logic in handler!
    return res.status(400).json({ error: 'Suspended' });
  }
  const order = new Order(...);
  await db.collection('orders').insertOne(order);
  await sendEmail(req.body.email, 'Confirmed');
  res.json(order);
});
```

**Why this violates the architecture:**
- Business logic becomes scattered across handlers
- Logic is not reusable (CLI, workers can't use it)
- Testing requires HTTP layer
- Handlers become bloated and hard to maintain

**Handler responsibilities (only these):**
1. Validate input (using Zod schemas)
2. Call the action
3. Return the response

**The fix:**

```typescript
// ✅ Good - handler delegates to action
app.post('/orders', async (req, res, next) => {
  // 1. Validate input
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  // 2. Call action
  try {
    const order = await createOrder(deps, req.ctx, parsed.data);
    res.status(201).json({ id: order.id });
  } catch (error) {
    next(error);
  }
});
```

See [Anti-Pattern AP-2](./08-rules-and-guidelines.md#ap-2-business-logic-in-handler).

---

### Can shared package import from core?

**Short answer:** Never. Shared only contains types for frontend.

**The import rule:**

```
packages/shared/ → External libs only (zod, etc.)
                 → NOT @packages/core
                 → NOT @packages/infra
                 → NOT apps/
```

**Why:**
- `packages/shared/` is used by the frontend (`apps/web/`)
- Frontend cannot (and should not) import backend business logic
- Shared contains only: API types, validation schemas, constants

**What belongs in shared:**

| Belongs in `shared/` | Does NOT belong |
|---------------------|-----------------|
| Request/Response DTOs | Entity classes |
| Zod validation schemas | Business logic |
| Status constants/enums | Repository interfaces |
| Simple value types (Address) | Actions or queries |

**Example:**

```typescript
// ✅ packages/shared/src/api-types/orders.ts
export interface CreateOrderRequest {
  customerId: string;
  items: Array<{ productId: string; quantity: number }>;
}

export interface OrderResponse {
  id: string;
  status: string;
  total: number;
  createdAt: string;  // Note: string, not Date
}
```

See [Anti-Pattern AP-8](./08-rules-and-guidelines.md#ap-8-shared-package-importing-internal-packages) and [The Shared Package](./14-shared-package.md).

---

## Testing

<!-- Add FAQs about testing here -->

---

## Related Documentation

| Topic | File |
|-------|------|
| Shared package guidelines | [14-shared-package.md](./14-shared-package.md) |
| Domain objects | [03-domain-objects.md](./03-domain-objects.md) |
| Contracts | [04-contracts.md](./04-contracts.md) |
| Import rules | [08-rules-and-guidelines.md](./08-rules-and-guidelines.md) |
