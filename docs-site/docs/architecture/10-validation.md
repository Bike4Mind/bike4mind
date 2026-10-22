---
title: Validation
description: "Three validation layers: Input (API, 400), Business (Action, 404/422), Invariant (Entity, 422)."
sidebar_position: 11
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Validation

[← Back to README](./README.md)

<!-- SUMMARY -->

Three validation layers: Input (API, 400), Business (Action, 404/422), Invariant (Entity, 422).
Use NotFoundError for missing resources, BusinessError for rule violations, InvariantError for invalid state transitions.
Validate input BEFORE calling core. Entity validates itself during state changes.

<!-- /SUMMARY -->

---

## Types of Validation

<!-- VALIDATION-LAYERS: Three distinct layers with different purposes -->

Validation happens at three different layers, each with a specific purpose.

| Type                     | Question                        | Where     | Fails With      |
| ------------------------ | ------------------------------- | --------- | --------------- |
| **Input Validation**     | Is the data well-formed?        | API Layer | 400 Bad Request |
| **Business Validation**  | Is the operation allowed?       | Action    | 404 / 422       |
| **Invariant Validation** | Is this state transition valid? | Entity    | 422             |

---

## Error Types

| Error | Thrown By | When to Use |
|-------|-----------|-------------|
| `NotFoundError` | Action | Resource doesn't exist |
| `BusinessError` | Action | Business rule prevents operation |
| `InvariantError` | Entity | Invalid state transition |

For error class definitions, see [Error Handling](./16-error-handling.md).

---

## 1. Input Validation (API Layer)

Validate data shape and format **before** entering core. Reject bad data early.

```typescript
// apps/client/pages/api/validators/orderValidators.ts
import { z } from "zod"; // or Joi, Yup, class-validator, etc.

export const createOrderSchema = z.object({
  customerId: z.string().uuid("Invalid customer ID format"),
  email: z.string().email("Invalid email address"),
  items: z
    .array(
      z.object({
        productId: z.string().uuid("Invalid product ID"),
        quantity: z.number().int().min(1, "Quantity must be at least 1"),
        price: z.number().positive("Price must be positive"),
      }),
    )
    .min(1, "Order must have at least one item"),
});

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
```

```typescript
// apps/client/pages/api/orders/index.ts
import { baseApi } from "@server/middlewares/baseApi";
import { createOrderSchema } from "../validators/orderValidators";
import { createOrder } from "@packages/core/orders";

const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    // 1. Input validation FIRST
    const parsed = createOrderSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }

    // 2. Now safe to call core
    const order = await createOrder(deps, req.ctx, parsed.data);
    res.status(201).json({ id: order.id });
  });

export default handler;
```

**What to validate here:**

- Required fields present
- Correct data types
- String formats (email, UUID, URL)
- Number ranges
- Array lengths

---

## 2. Business Validation (Action)

Check things that require **fetching data** or **external checks**.

```typescript
// packages/core/src/orders/actions/createOrder.ts
import { Order, OrderItem } from "../Order";
import { OrderRepository } from "../OrderRepository";
import { OrderPolicies } from "../OrderPolicies";
import { Mailer } from "../../shared/Mailer";
import { AuthContext } from "../../shared/authorization";
import { NotFoundError, BusinessError } from "../../shared/errors";

// Cross-feature data interfaces - defined HERE, not imported
// See Cross-Feature Communication (13-cross-feature-communication.md) for details
export interface CustomerData {
  id: string;
  status: "active" | "suspended";
}

export interface ProductData {
  id: string;
  name: string;
  stock: number;
}

export interface CreateOrderDeps {
  repository: OrderRepository;
  mailer: Mailer;
  // Function dependencies for cross-feature data
  getCustomer: (customerId: string) => Promise<CustomerData | null>;
  getProduct: (productId: string) => Promise<ProductData | null>;
}

export interface CreateOrderInput {
  customerId: string;
  email: string;
  items: OrderItem[];
}

export async function createOrder(
  deps: CreateOrderDeps,
  ctx: AuthContext,
  input: CreateOrderInput,
): Promise<Order> {
  // Authorization check
  if (!OrderPolicies.canCreate(ctx)) {
    throw new BusinessError("Not authorized to create orders");
  }

  // Business validation - uses function dependencies
  const customer = await deps.getCustomer(input.customerId);
  if (!customer) {
    throw new NotFoundError("Customer not found");
  }

  if (customer.status === "suspended") {
    throw new BusinessError("Suspended customers cannot place orders");
  }

  // Check stock for each item
  for (const item of input.items) {
    const product = await deps.getProduct(item.productId);
    if (!product) {
      throw new NotFoundError(`Product ${item.productId} not found`);
    }
    if (product.stock < item.quantity) {
      throw new BusinessError(`Insufficient stock for ${product.name}`);
    }
  }

  // Validation passed - create order
  const order = new Order(crypto.randomUUID(), input.customerId, input.items);
  order.submit(); // May throw InvariantError

  await deps.repository.save(order);
  await deps.mailer.send(input.email, "Order Confirmed", `Order #${order.id}`);

  return order;
}
```

**What to validate here:**

- Resource exists (customer, product, etc.)
- User has permission
- Business rules (stock available, account active, limits not exceeded)

---

## 3. Invariant Validation (Entity)

Protect the entity from **invalid states**. These rules must **always** be true.

```typescript
// packages/core/src/orders/Order.ts
import { InvariantError } from "../shared/errors";

export class Order {
  submit(): void {
    if (this.items.length === 0) {
      throw new InvariantError("Cannot submit empty order");
    }
    if (this.status !== "draft") {
      throw new InvariantError("Order already submitted");
    }
    this.status = "submitted";
  }

  cancel(reason: string): void {
    if (!this.canCancel()) {
      throw new InvariantError(`Cannot cancel order in ${this.status} status`);
    }
    this.status = "cancelled";
    this.cancelReason = reason;
  }

  addItem(item: OrderItem): void {
    if (!this.canModify()) {
      throw new InvariantError("Cannot modify submitted order");
    }
    if (item.quantity <= 0) {
      throw new InvariantError("Quantity must be positive");
    }
    this.items.push(item);
  }
}
```

**What to validate here:**

- State transitions are valid
- Entity constraints (non-empty, positive values)
- Domain rules that must never be violated

---

## 4. Error Handler Middleware

Convert error types to appropriate HTTP responses:

```typescript
// apps/client/server/middlewares/baseApi.ts
function handleError(err: unknown, res: NextApiResponse) {
  if (err instanceof Error) {
    // Resource not found
    if (err.name === 'NotFoundError') {
      return res.status(404).json({ error: err.message });
    }

    // Business rule or invariant violation
    if (err.name === 'BusinessError' || err.name === 'InvariantError') {
      return res.status(422).json({ error: err.message });
    }
  }

  // Unknown error - log and return generic message
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
```

---

## Validation Flow

```
Request arrives
     │
     ▼
┌─────────────────────────────────────┐
│ API: Input Validation               │
│ "Is email valid? Are fields present?"│
│                                     │
│ ❌ 400 Bad Request                  │
└─────────────────┬───────────────────┘
                  │ ✅
                  ▼
┌─────────────────────────────────────┐
│ Action: Business Validation         │
│ "Does customer exist? Stock ok?"    │
│                                     │
│ ❌ 404 Not Found / 422 Unprocessable│
└─────────────────┬───────────────────┘
                  │ ✅
                  ▼
┌─────────────────────────────────────┐
│ Entity: Invariant Validation        │
│ "Can this state transition happen?" │
│                                     │
│ ❌ 422 Unprocessable                │
└─────────────────┬───────────────────┘
                  │ ✅
                  ▼
            Success! 201
```

---

## Summary: Where Each Error Is Thrown

| Error Type       | Thrown In  | Example                                  |
| ---------------- | ---------- | ---------------------------------------- |
| `NotFoundError`  | **Action** | Customer not found, Product not found    |
| `BusinessError`  | **Action** | Account suspended, Insufficient stock    |
| `InvariantError` | **Entity** | Cannot cancel shipped order, Empty order |

---

## Next Steps

- [Transactions](./12-transactions.md) - Learn about database transactions
- [Testing](./15-testing.md) - Learn about testing validation
- [Actions](./05-actions.md) - Learn more about business validation
