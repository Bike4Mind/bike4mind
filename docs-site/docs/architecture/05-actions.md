---
title: Actions
description: "Actions orchestrate business operations. Two types: User actions (deps, ctx, input) and System actions (deps, input)."
sidebar_position: 6
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Actions

[← Back to README](./README.md)

<!-- SUMMARY -->
Actions orchestrate business operations. Two types: User actions (deps, ctx, input) and System actions (deps, input).
Pattern: Load -> Authorize -> Validate -> Execute -> Persist -> Side Effects.
Throw NotFoundError for missing resources, BusinessError for rule violations.
<!-- /SUMMARY -->

---

## What Are Actions?

Actions are single-purpose functions that orchestrate business operations:
- Coordinate domain objects and external systems
- Check authorization using policies
- Handle business validation (database lookups)
- Manage side effects (emails, notifications)
- Throw `NotFoundError` or `BusinessError` when operations fail

---

## Two Types of Actions

| Type | Signature | Called From | Has Auth Check |
|------|-----------|-------------|----------------|
| **User Action** | `(deps, ctx, input)` | API handlers, CLI | Yes |
| **System Action** | `(deps, input)` | Workers, schedulers | No |

### User Actions

Triggered by authenticated users, require authorization:

```typescript
export async function createOrder(
  deps: CreateOrderDeps,
  ctx: AuthContext,          // Who is making this request?
  input: CreateOrderInput
): Promise<Order>
```

### System Actions

Triggered by automated processes, no user context:

```typescript
export async function systemExpireStaleOrders(
  deps: ExpireStaleOrdersDeps,
  input: { olderThanDays: number }
): Promise<number>
```

Prefix system actions with `system` to distinguish them:
```typescript
createOrder(deps, ctx, input)           // User action
systemExpireStaleOrders(deps, input)    // System action
```

---

## User Action Signature

```typescript
export async function actionName(
  deps: ActionNameDeps,      // 1. Dependencies (repositories, services)
  ctx: AuthContext,          // 2. Auth context (who's calling)
  input: ActionNameInput     // 3. Action-specific data
): Promise<ReturnType>
```

| Parameter | Purpose |
|-----------|---------|
| `deps` | External systems (repositories, mailers, gateways) |
| `ctx` | Authenticated user's identity and permissions |
| `input` | Data needed to perform the action |

See [Authorization](./09-authorization.md) for `AuthContext` definition.

---

## Action Pattern: Load -> Authorize -> Validate -> Execute -> Persist -> Side Effects

```typescript
export async function cancelOrder(
  deps: CancelOrderDeps,
  ctx: AuthContext,
  input: CancelOrderInput
): Promise<Order> {
  // 1. LOAD - Fetch required data
  const order = await deps.repository.findById(input.orderId);
  if (!order) throw new NotFoundError('Order not found');

  // 2. AUTHORIZE - Check permissions
  if (!OrderPolicies.canCancel(ctx, order)) {
    throw new BusinessError('Not authorized to cancel this order');
  }

  // 3. VALIDATE - Business validation (optional)
  if (!order.canCancel()) {
    throw new BusinessError('This order cannot be cancelled');
  }

  // 4. EXECUTE - State change
  order.cancel(input.reason);

  // 5. PERSIST - Save changes
  await deps.repository.save(order);

  // 6. SIDE EFFECTS - External notifications
  await deps.mailer.send(input.email, 'Cancelled', `Order #${order.id}`);

  return order;
}
```

---

## Example: Simple Create Action

```typescript
// packages/core/src/orders/actions/createOrder.ts
export interface CreateOrderDeps {
  repository: OrderRepository;
  mailer: Mailer;
}

export interface CreateOrderInput {
  customerId: string;
  email: string;
  items: OrderItem[];
}

export async function createOrder(
  deps: CreateOrderDeps,
  ctx: AuthContext,
  input: CreateOrderInput
): Promise<Order> {
  if (!OrderPolicies.canCreate(ctx)) {
    throw new BusinessError('Not authorized to create orders');
  }

  const order = new Order(crypto.randomUUID(), input.customerId, input.items);
  order.submit();
  await deps.repository.save(order);

  await deps.mailer.send(input.email, 'Order Confirmed', `Order #${order.id} placed.`);

  return order;
}
```

---

## Example: Action with Cross-Feature Dependencies

For actions needing to read or write data from other features, use function dependencies (see [Cross-Feature Communication](./13-cross-feature-communication.md)):

```typescript
// Define what we NEED (not imported from other features)
export interface CustomerData {
  id: string;
  name: string;
  email: string;
  isInGoodStanding: boolean;
}

export interface StockCheckResult {
  productId: string;
  productName: string;
  available: boolean;
  availableQuantity: number;
}

export interface QuestUpdateData {
  status: 'stopped' | 'error';
  replies: string[];
}

export interface CreateOrderDeps {
  repository: OrderRepository;
  mailer: Mailer;
  // Read from other features
  getCustomer: (customerId: string) => Promise<CustomerData | null>;
  checkStock: (productId: string, quantity: number) => Promise<StockCheckResult>;
  // Write to other features - equally valid!
  updateQuest: (questId: string, data: QuestUpdateData) => Promise<void>;
}

export async function createOrder(
  deps: CreateOrderDeps,
  ctx: AuthContext,
  input: CreateOrderInput
): Promise<Order> {
  if (!OrderPolicies.canCreate(ctx)) {
    throw new BusinessError('Not authorized to create orders');
  }

  // Business validation via function dependencies
  const customer = await deps.getCustomer(input.customerId);
  if (!customer) throw new NotFoundError('Customer not found');
  if (!customer.isInGoodStanding) {
    throw new BusinessError('Customer account is not in good standing');
  }

  for (const item of input.items) {
    const stock = await deps.checkStock(item.productId, item.quantity);
    if (!stock.available) {
      throw new BusinessError(`Insufficient stock for ${stock.productName}`);
    }
  }

  const order = new Order(crypto.randomUUID(), input.customerId, input.items);
  order.submit();
  await deps.repository.save(order);

  await deps.mailer.send(customer.email, 'Order Confirmed', `Order #${order.id} placed.`);

  return order;
}
```

---

## Example: System Action

```typescript
// packages/core/src/orders/actions/systemExpireStaleOrders.ts
export interface SystemExpireStaleOrdersDeps {
  repository: OrderRepository;
  mailer: Mailer;
}

export async function systemExpireStaleOrders(
  deps: SystemExpireStaleOrdersDeps,
  input: { olderThanDays: number }
): Promise<number> {
  const staleOrders = await deps.repository.findStale(input.olderThanDays);

  for (const order of staleOrders) {
    order.cancel('Expired - no payment received');
    await deps.repository.save(order);
    await deps.mailer.send(order.customerEmail, 'Order Expired', `Order #${order.id} expired.`);
  }

  return staleOrders.length;
}
```

Called from a worker:

```typescript
// apps/worker/src/jobs/expireOrders.ts
export async function expireOrdersJob(deps: OrderDeps) {
  const count = await systemExpireStaleOrders(deps, { olderThanDays: 7 });
  console.log(`[Worker] Expired ${count} stale orders`);
}
```

---

## What Goes in Actions vs Entities

| In Actions | In Entities |
|------------|-------------|
| Authorization (policies) | State validation |
| Loading from database | State transitions |
| Saving to database | Computed properties |
| Sending emails | Business invariants |
| External API calls | `canDoX()` checks |
| Logging / analytics | Core calculations |

---

## Complex Actions: Step Functions

When actions become complex, break into discrete, testable steps:

```typescript
// Step functions (private, testable)
async function loadAndValidateCustomer(deps, customerId: string): Promise<CustomerData> {
  const customer = await deps.getCustomer(customerId);
  if (!customer) throw new NotFoundError('Customer not found');
  if (!customer.isInGoodStanding) throw new BusinessError('Customer not in good standing');
  return customer;
}

async function validateStock(deps, items: OrderItem[]): Promise<void> {
  for (const item of items) {
    const stock = await deps.checkStock(item.productId, item.quantity);
    if (!stock.available) throw new BusinessError(`Insufficient stock for ${stock.productName}`);
  }
}

async function handlePayment(deps, customerId: string, amount: number): Promise<string> {
  const result = await deps.processPayment(customerId, amount);
  if (!result.success) throw new BusinessError(`Payment failed: ${result.error}`);
  return result.transactionId!;
}

// Main action orchestrates steps
export async function createOrderWithPayment(
  deps: CreateOrderWithPaymentDeps,
  ctx: AuthContext,
  input: CreateOrderInput
): Promise<Order> {
  if (!OrderPolicies.canCreate(ctx)) throw new BusinessError('Not authorized');

  const customer = await loadAndValidateCustomer(deps, input.customerId);
  await validateStock(deps, input.items);

  const order = new Order(crypto.randomUUID(), input.customerId, input.items);
  order.submit();

  const transactionId = await handlePayment(deps, customer.id, order.total);
  order.markPaid(transactionId);

  await deps.repository.save(order);

  // Non-critical side effects - don't fail the order
  await sendNotifications(deps, order, customer).catch(console.error);

  return order;
}
```

| Situation | Use Step Functions? |
|-----------|---------------------|
| Simple CRUD (3-4 operations) | No |
| 5+ distinct operations | Yes |
| Multiple validation checks | Yes |
| Steps need independent testing | Yes |
| Same steps in multiple actions | Yes, extract and reuse |

---

## Organizing Actions

Keep actions in a flat folder structure:

```
packages/core/src/orders/
|- Order.ts
|- OrderRepository.ts
|- actions/
|   |- createOrder.ts
|   |- cancelOrder.ts
|   +- shipOrder.ts
+- index.ts
```

### Exporting Actions

```typescript
// packages/core/src/orders/index.ts
export { Order, OrderItem, OrderStatus } from './Order';
export { OrderRepository } from './OrderRepository';
export { createOrder, CreateOrderInput, CreateOrderDeps } from './actions/createOrder';
export { cancelOrder, CancelOrderInput, CancelOrderDeps } from './actions/cancelOrder';
```

### When to Split Features

If a feature has 15+ actions or actions deal with distinct sub-entities, consider splitting. See [Feature Design](./02-feature-design.md) for guidance.

---

## Dependencies Interface

For cross-feature data, use function dependencies. These work for both **reading** and **writing**:

```typescript
// Basic - single feature only
export interface CreateOrderDeps {
  repository: OrderRepository;
  mailer: Mailer;
}

// With cross-feature dependencies (both read AND write)
export interface CreateOrderDeps {
  repository: OrderRepository;
  mailer: Mailer;
  // Read from other features
  getCustomer: (customerId: string) => Promise<CustomerData | null>;
  checkStock: (productId: string, quantity: number) => Promise<StockCheckResult>;
  // Write to other features - equally valid!
  updateQuest: (questId: string, data: QuestUpdateData) => Promise<void>;
}
```

### Input Interface

Always use an object, even for single values:

```typescript
export interface CreateOrderInput {
  customerId: string;
  email: string;
  items: OrderItem[];
}

// Even for simple actions
export interface GetOrderInput {
  orderId: string;
}
```

---

## System vs User Actions

| Criteria | User Action | System Action |
|----------|-------------|---------------|
| Caller | API route, queue handler processing a user request | Cron job, system maintenance, internal automation |
| AuthContext | Required — `(deps, ctx, input)` | Not present — `(deps, input)` |
| Authorization | Action checks user access | No user to authorize |
| Naming | `{verbNoun}.ts` | `system{VerbNoun}.ts` |
| Example | `getProject`, `getUser` | `systemExpireOrders`, `systemCleanupStaleData` |

**Rule of thumb:** If there's a user behind the request (even indirectly through a queue), it's a user action. System actions are for truly autonomous operations.

---

## Cross-Feature Action Reuse

When a core action needs data/behavior from another domain, it does NOT import directly. Instead:

1. **Check if the source domain already has an action** that provides what you need
2. **If not, create the action in the source domain** — the action belongs where the data lives
3. **Declare a function dep** with locally-defined types in the consuming action — no imports from the source domain
4. **Wire at the entry point** — the entry point calls the source domain's action and passes the result through the function dep

**Example — `getProjectSystemPrompts` needs file contents:**
```
core/projects/getProjectSystemPrompts.ts
  └─ declares dep: getFileContents: (fileIds, userId) => Promise<FileContentItem[]>
  └─ FileContentItem defined locally (no import from core/files)

core/files/getFileContents.ts
  └─ already exists, returns FileWithContent[] (structurally compatible)

Entry point (questProcessor.ts)
  └─ wires: getFileContents action → getProjectSystemPrompts.getFileContents dep
```

**Anti-pattern:** Importing `getFileContents` directly inside `getProjectSystemPrompts` — this creates a hidden cross-feature coupling that bypasses the dependency injection pattern.

---

## Next Steps

- [CQRS and Read Models](./11-cqrs-and-read-models.md) - Queries and DTOs
- [Authorization](./09-authorization.md) - Policies and permissions
- [Validation](./10-validation.md) - Validation strategies
- [Transactions](./12-transactions.md) - Database transactions
- [Cross-Feature Communication](./13-cross-feature-communication.md) - Function dependencies
