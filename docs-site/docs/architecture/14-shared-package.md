---
title: The Shared Package
description: When you have multiple apps (server, web, mobile), they often need the same types — a shared package keeps them in sync.
sidebar_position: 15
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# The Shared Package

[← Back to README](./README.md)

---

## Why a Shared Package?

When you have multiple apps (server, web, mobile), they often need the same types:

```
THE PROBLEM                          THE SOLUTION

apps/client/server/  apps/client/src/    packages/shared/
OrderDTO { ... }     OrderDTO { ... }     OrderDTO { ... }  <- Single source
Types get out of sync!                   All apps import from shared
```

---

## What Belongs in Shared

| Put in `shared/` | Keep in `core/` |
|------------------|-----------------|
| API request/response types | Entities (write models) |
| Validation schemas (Zod) | Business logic |
| Enums and constants | Contracts (interfaces) |
| Error codes | Actions and queries |
| Common utilities | Domain rules |

**Rule**: If a frontend needs it, put it in `shared/`. If it's internal business logic, keep it in `core/`.

---

## Folder Structure

```
packages/
|- core/                       # Business logic (backend only)
|   +- src/orders/
|       |- Order.ts            # Entity (internal)
|       +- OrderRepository.ts
|
|- infra/                      # Infrastructure (backend only)
|
+- shared/                     # Shared across all apps
    +- src/
        |- api-types/          # Request/Response DTOs
        |   |- orders.ts
        |   +- index.ts
        |
        |- validation/         # Zod schemas
        |   |- orders.ts
        |   +- index.ts
        |
        +- constants/          # Shared constants
            +- orderStatuses.ts
```

---

## API Types

Define what your API receives and returns:

```typescript
// packages/shared/src/api-types/orders.ts

export type OrderStatus = 'draft' | 'submitted' | 'paid' | 'shipped' | 'cancelled';

export interface OrderSummary {
  id: string;
  customerName: string;
  total: number;
  status: OrderStatus;
  createdAt: string;  // ISO string for JSON
}

export interface OrderDetails {
  id: string;
  customer: { id: string; name: string; email: string };
  items: OrderLineItem[];
  total: number;
  status: OrderStatus;
  canCancel: boolean;
}

export interface CreateOrderRequest {
  customerId: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
}

export interface ApiResponse<T> { data: T; }
export interface ApiError { error: string; code?: string; }
```

---

## Shared Validation (Zod)

Use Zod schemas for validation on both frontend and backend:

```typescript
// packages/shared/src/validation/orders.ts
import { z } from 'zod';

export const createOrderSchema = z.object({
  customerId: z.string().uuid('Invalid customer ID'),
  items: z.array(z.object({
    productId: z.string().uuid('Invalid product ID'),
    quantity: z.number().int().min(1, 'Quantity must be at least 1'),
    price: z.number().positive('Price must be positive'),
  })).min(1, 'Order must have at least one item'),
});

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
```

**Backend usage:**

```typescript
const parsed = createOrderSchema.safeParse(req.body);
if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
const order = await createOrder(deps, req.ctx, parsed.data);
```

**Frontend usage:**

```typescript
const result = createOrderSchema.safeParse(formData);
if (!result.success) setErrors(result.error.flatten().fieldErrors);
```

---

## Shared Constants

```typescript
// packages/shared/src/constants/orderStatuses.ts
export const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Pending Payment',
  paid: 'Paid',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
};

export const CANCELLABLE_STATUSES = ['draft', 'submitted', 'paid'] as const;
```

---

## Import Rules

See [Rules & Guidelines](./08-rules-and-guidelines.md) for complete import rules.

| Package | Can Import From |
|---------|-----------------|
| `packages/shared` | External libs only (zod, etc.) |
| `packages/core` | `@packages/shared` |
| `packages/infra` | `@packages/core`, `@packages/shared` |
| `apps/client/server` | Everything |
| `apps/client/src` | `@packages/shared` only |

**Key rule**: `shared` has no internal dependencies.

---

## Usage Examples

### Backend Handler

```typescript
// apps/client/pages/api/orders/index.ts
import { OrderDetails, ApiResponse } from '@packages/shared/api-types';
import { createOrderSchema } from '@packages/shared/validation/orders';
import { baseApi } from '@server/middlewares/baseApi';
import { createOrder } from '@packages/core/orders';

const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

    const order = await createOrder(deps, req.ctx, parsed.data);
    const response: ApiResponse<OrderDetails> = { data: order };
    res.status(201).json(response);
  });

export default handler;
```

### Frontend API Client

```typescript
// apps/client/src/api/orders.ts
import { OrderDetails, CreateOrderRequest, ApiResponse } from '@packages/shared/api-types';

export async function createOrder(data: CreateOrderRequest): Promise<OrderDetails> {
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json: ApiResponse<OrderDetails> = await res.json();
  return json.data;
}
```

---

## When NOT to Use Shared

| Keep Out of Shared | Why |
|--------------------|-----|
| Entities | Internal to backend |
| Business logic | Backend only |
| Database contracts | Backend only |
| React components | Frontend only |
| Next.js middleware | Backend only |

**If only one app uses it, don't share it.**

---

## Relationship to Core Read Models

| Where | When |
|-------|------|
| `core/{feature}/OrderReadModels.ts` | Backend-only queries |
| `shared/api-types/orders.ts` | Exposed via API, consumed by frontend |

In practice, they're often the same. You can define in core and re-export from shared if needed.

---

## Next Steps

- [CQRS and Read Models](./11-cqrs-and-read-models.md) - Read model patterns
- [Rules & Guidelines](./08-rules-and-guidelines.md) - Import rules
- [Contracts](./04-contracts.md) - Cross-feature contracts
