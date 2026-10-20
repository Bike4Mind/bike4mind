---
title: Error Handling
description: "The error taxonomy: NotFoundError (404), BusinessError (422), and InvariantError (422), and how each maps to HTTP status."
sidebar_position: 17
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Error Handling

[← Back to README](./README.md)

---

## Quick Reference

| Error Type | Thrown By | Meaning | HTTP Status |
|------------|-----------|---------|-------------|
| `NotFoundError` | Action | Resource doesn't exist | 404 |
| `BusinessError` | Action | Business rule prevents operation | 422 |
| `InvariantError` | Entity | Invalid state transition | 422 |

```typescript
// packages/core/src/shared/errors.ts
export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'NotFoundError'; }
}

export class BusinessError extends Error {
  constructor(message: string) { super(message); this.name = 'BusinessError'; }
}

export class InvariantError extends Error {
  constructor(message: string) { super(message); this.name = 'InvariantError'; }
}
```

---

## The Hybrid Pattern: Throw vs Result

- **Exceptions** (default): For errors that stop the operation
- **Result types**: For expected alternative outcomes the caller must handle

> **Use exceptions** when the operation cannot proceed.
> **Use Result** when both success and failure are normal business paths.

---

## When to Use Exceptions (Default)

| Scenario | Error Type |
|----------|------------|
| Resource not found | `NotFoundError` |
| User not authorized | `BusinessError` |
| Business rule violated | `BusinessError` |
| Invalid state transition | `InvariantError` |
| Infrastructure failure | Native `Error` |

```typescript
export async function cancelOrder(deps, ctx, input): Promise<Order> {
  const order = await deps.repository.findById(input.orderId);
  if (!order) throw new NotFoundError('Order not found');

  if (!OrderPolicies.canCancel(ctx, order)) {
    throw new BusinessError('Not authorized to cancel this order');
  }

  order.cancel(input.reason);  // May throw InvariantError
  await deps.repository.save(order);
  return order;
}
```

---

## When to Use Result Types

Use Result when both outcomes are expected and caller must handle both:

```typescript
// packages/core/src/shared/Result.ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const Result = {
  ok: <T>(value: T): Result<T, never> => ({ ok: true, value }),
  err: <E>(error: E): Result<never, E> => ({ ok: false, error }),
};
```

**Example: Payment Processing**

Payment can legitimately be declined - not exceptional, it's a normal business outcome:

```typescript
// packages/core/src/payments/PaymentGateway.ts
export interface PaymentGateway {
  charge(customerId: string, amount: number): Promise<Result<
    { transactionId: string; amount: number },
    { reason: 'insufficient_funds' | 'card_expired' | 'fraud_detected'; message: string }
  >>;
}

// In action
const paymentResult = await deps.paymentGateway.charge(order.customerId, order.total);
if (!paymentResult.ok) {
  throw new BusinessError(`Payment declined: ${paymentResult.error.message}`);
}
order.markPaid(paymentResult.value.transactionId);
```

**Example: Non-Critical Notification**

```typescript
const smsResult = await deps.smsService.send(customer.phone, 'Order shipped!');
if (!smsResult.ok) {
  deps.logger.warn({ event: 'sms.delivery_failed', reason: smsResult.error.reason });
  // Don't fail the operation
}
```

### Decision Guide

| Scenario | Pattern | Reasoning |
|----------|---------|-----------|
| Payment declined | Result | Caller decides: retry? show message? |
| Order not found | Exception | Operation cannot proceed |
| Email delivery failed | Result | Non-critical, caller may ignore |
| Customer suspended | Exception | Business rule, operation stops |
| Rate limit hit | Result | Caller may retry with backoff |

---

## Correlation IDs

Attach a unique ID at entry point, flow through the system for tracing:

```typescript
// packages/core/src/shared/authorization/AuthContext.ts
export interface AuthContext {
  userId: string;
  roles: string[];
  isAdmin: boolean;
  requestId: string;  // Correlation ID
}
```

Generate in auth middleware:

```typescript
// apps/client/server/middlewares/baseApi.ts
function createHandler(method: string, handler: Handler, options: BaseApiOptions) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const requestId = req.headers['x-request-id'] as string || crypto.randomUUID();

    if (options.auth) {
      const user = await verifyToken(token);
      req.ctx = {
        userId: user.id,
        roles: user.roles,
        isAdmin: user.roles.includes('admin'),
        requestId,
      };
    }

    res.setHeader('x-request-id', requestId);
    // ... rest of handler
  };
}
```

For system actions (workers), generate a job-scoped ID:

```typescript
export async function expireOrdersJob(deps: OrderDeps) {
  const jobId = `job-${crypto.randomUUID()}`;
  deps.logger.info({ requestId: jobId, event: 'job.started' });
  // ...
}
```

---

## Partial Failure Handling

When an action performs multiple operations, handle cleanup on failure.

### Strategy 1: Transactions (DB Operations)

```typescript
const order = await deps.tx.run(async () => {
  const order = new Order(...);
  await deps.orderRepository.save(order);
  await deps.inventoryRepository.reserve(items);  // Rolls back if fails
  return order;
});
// External calls AFTER transaction
await deps.mailer.send(...);
```

See [Transactions](./12-transactions.md) for details.

### Strategy 2: Compensating Actions (External Systems)

```typescript
export async function createPaidOrder(deps, ctx, input): Promise<Order> {
  const order = new Order(...);
  await deps.orderRepository.save(order);

  try {
    await deps.inventoryService.reserve(order.id, order.items);
  } catch (error) {
    await deps.orderRepository.delete(order.id);  // Compensate
    throw new BusinessError('Failed to reserve inventory');
  }

  const paymentResult = await deps.paymentGateway.charge(order.customerId, order.total);
  if (!paymentResult.ok) {
    await deps.inventoryService.release(order.id);  // Compensate
    order.cancel('Payment failed');
    await deps.orderRepository.save(order);
    throw new BusinessError(`Payment declined: ${paymentResult.error.message}`);
  }

  order.markPaid(paymentResult.value.transactionId);
  await deps.orderRepository.save(order);
  return order;
}
```

| Scenario | Strategy |
|----------|----------|
| All operations are DB writes | Transaction |
| Mix of DB and external APIs | Compensating actions |
| Critical operations (money, legal) | Consider saga pattern |

---

## Error Handler Middleware

```typescript
// apps/client/server/middlewares/baseApi.ts
function handleError(err: unknown, res: NextApiResponse, requestId?: string) {
  if (err instanceof Error) {
    let status: number;
    switch (err.name) {
      case 'NotFoundError':
        status = 404;
        break;
      case 'BusinessError':
      case 'InvariantError':
        status = 422;
        break;
      default:
        status = 500;
        console.error({ requestId, error: err.message, stack: err.stack });
    }

    res.status(status).json({
      error: status === 500 ? 'Internal server error' : err.message,
      requestId,
    });
  }
}
```

---

## Summary

| Concept | Rule |
|---------|------|
| **Default to exceptions** | NotFoundError, BusinessError, InvariantError |
| **Use Result for expected outcomes** | Payment declined, SMS failed, rate limited |
| **Correlation IDs** | Attach at entry point, flow through AuthContext |
| **Partial failures** | Transactions for DB, compensating actions for external |
| **Logging** | At boundaries only, structured format |

---

## Next Steps

- [Validation](./10-validation.md) - Input, business, and invariant validation
- [Transactions](./12-transactions.md) - Database atomicity
