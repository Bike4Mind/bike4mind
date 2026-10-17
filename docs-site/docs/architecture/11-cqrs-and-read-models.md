---
title: CQRS and Read Models
description: "CQRS (Command Query Responsibility Segregation) splits your application into two sides: commands (writes) and queries (reads)."
sidebar_position: 12
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# CQRS and Read Models

[← Back to README](./README.md)

---

## The Core Idea

CQRS (Command Query Responsibility Segregation) splits your application into two sides:

```
┌─────────────────────────────────────────────────────────┐
│                      YOUR APP                           │
│                                                         │
│   ┌─────────────────┐       ┌─────────────────┐        │
│   │    COMMANDS     │       │     QUERIES     │        │
│   │    (Writes)     │       │     (Reads)     │        │
│   │                 │       │                 │        │
│   │  createOrder    │       │  getOrder       │        │
│   │  cancelOrder    │       │  listOrders     │        │
│   │  updateUser     │       │  searchProducts │        │
│   └────────┬────────┘       └────────┬────────┘        │
│            │                         │                  │
│            ▼                         ▼                  │
│   ┌─────────────────┐       ┌─────────────────┐        │
│   │  Write Model    │       │   Read Model    │        │
│   │  (Entities)     │       │   (DTOs)        │        │
│   └─────────────────┘       └─────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

| Term | Definition |
|------|------------|
| **Command** | "Do something" - changes state |
| **Query** | "Tell me something" - returns data, no side effects |

---

## How It Relates to This Architecture

Your current architecture already has this separation implicitly:

| Your Pattern | CQRS Term |
|--------------|-----------|
| Actions that modify state (`createOrder`, `cancelOrder`) | Commands |
| Actions that fetch data (`getOrder`, `listOrders`) | Queries |

The question is: **should they use the same model?**

---

## The Problem CQRS Solves

Your entity is optimized for **writes**:

```typescript
// Entity - optimized for state management and validation
class Order {
  constructor(
    public readonly id: string,
    public readonly customerId: string,  // Just an ID
    public items: OrderItem[],           // Just product IDs and quantities
    public status: OrderStatus
  ) {}

  submit(): void { /* validation, state change */ }
  cancel(reason: string): void { /* validation, state change */ }
}
```

But your **read** needs are different:

```typescript
// What the UI actually needs to DISPLAY
{
  id: "ord-123",
  customerName: "John Doe",        // From Customer collection
  customerEmail: "john@example.com", // From Customer collection
  items: [
    {
      productName: "Widget",       // From Product collection
      quantity: 2,
      price: 10,
      imageUrl: "..."              // From Product collection
    }
  ],
  total: 20,
  status: "submitted",
  canCancel: true                  // Computed for UI
}
```

**The mismatch:**
- Write model has `customerId` → Read needs `customerName`
- Write model has `productId` → Read needs `productName`, `imageUrl`
- Read needs computed fields for UI
- Read often aggregates from multiple collections

---

## Read Models (DTOs)

A **DTO** (Data Transfer Object) is a simple object that carries data. No logic, no methods - just data shaped for the consumer.

```typescript
// packages/core/src/orders/OrderReadModels.ts

// List view - minimal data
export interface OrderSummary {
  id: string;
  customerName: string;
  itemCount: number;
  total: number;
  status: string;
  createdAt: Date;
}

// Detail view - everything the UI needs
export interface OrderDetails {
  id: string;
  customer: {
    id: string;
    name: string;
    email: string;
  };
  items: Array<{
    productId: string;
    productName: string;
    productImageUrl: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }>;
  subtotal: number;
  tax: number;
  total: number;
  status: string;
  canCancel: boolean;
  canRefund: boolean;
  createdAt: Date;
}
```

| Entity | DTO |
|--------|-----|
| Has business logic | Just data |
| Protects invariants | Shaped for consumer |
| Internal structure | External representation |

---

## Repository Pattern

Combine your writes and Queries (reads) into a single contract:

```typescript
// packages/core/src/orders/OrderRepository.ts
import { Order } from './Order';
import { OrderDetails, OrderSummary } from './OrderReadModels';

export interface OrderFilters {
  status?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

export interface OrderRepository {
  // === Writes (used by actions) ===
  save(order: Order): Promise<void>;

  // === Entity reads (used by actions that need to modify) ===
  findById(id: string): Promise<Order | null>;

  // === DTO reads (used by queries) ===
  getDetails(orderId: string): Promise<OrderDetails | null>;
  listByCustomer(customerId: string, filters?: OrderFilters): Promise<OrderSummary[]>;
  search(filters: OrderFilters): Promise<OrderSummary[]>;
}
```

**When to combine vs separate:**

| Situation | Recommendation |
|-----------|----------------|
| Small to medium app | Combined `Repository` |
| Very complex read requirements | Separate `Repository` + `Queries` |
| Different databases for read/write | Separate contracts |

---

## Queries Folder

Organize queries alongside actions:

```
packages/core/src/orders/
├── Order.ts                    # Entity (write model)
├── OrderRepository.ts          # Combined contract
├── OrderReadModels.ts          # DTOs
├── OrderPolicies.ts            # Authorization
├── actions/                    # Commands (writes)
│   ├── createOrder.ts
│   ├── cancelOrder.ts
│   └── ...
├── queries/                    # Queries (reads)
│   ├── getOrderDetails.ts
│   └── listCustomerOrders.ts
└── index.ts
```

---

## Query Function Signature

Queries follow the same pattern as actions:

```typescript
// packages/core/src/orders/queries/getOrderDetails.ts
import { OrderRepository } from '../OrderRepository';
import { OrderDetails } from '../OrderReadModels';
import { OrderPolicies } from '../OrderPolicies';
import { AuthContext } from '../../shared/authorization';
import { NotFoundError, BusinessError } from '../../shared/errors';

export interface GetOrderDetailsDeps {
  repository: OrderRepository;
}

export interface GetOrderDetailsInput {
  orderId: string;
}

export async function getOrderDetails(
  deps: GetOrderDetailsDeps,
  ctx: AuthContext,
  input: GetOrderDetailsInput
): Promise<OrderDetails> {
  // 1. Fetch the read model
  const order = await deps.repository.getDetails(input.orderId);

  if (!order) {
    throw new NotFoundError('Order not found');
  }

  // 2. Authorize
  if (!OrderPolicies.canView(ctx, order.customer.id)) {
    throw new BusinessError('Not authorized to view this order');
  }

  return order;
}
```

```typescript
// packages/core/src/orders/queries/listCustomerOrders.ts
import { OrderRepository, OrderFilters } from '../OrderRepository';
import { OrderSummary } from '../OrderReadModels';
import { OrderPolicies } from '../OrderPolicies';
import { AuthContext } from '../../shared/authorization';
import { BusinessError } from '../../shared/errors';

export interface ListCustomerOrdersDeps {
  repo: OrderRepository;
}

export interface ListCustomerOrdersInput {
  customerId: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listCustomerOrders(
  deps: ListCustomerOrdersDeps,
  ctx: AuthContext,
  input: ListCustomerOrdersInput
): Promise<OrderSummary[]> {
  // 1. Authorize
  if (!OrderPolicies.canViewCustomerOrders(ctx, input.customerId)) {
    throw new BusinessError('Not authorized to view these orders');
  }

  // 2. Build filters
  const filters: OrderFilters = {
    status: input.status,
    limit: input.limit ?? 20,
    offset: input.offset ?? 0,
  };

  // 3. Fetch and return
  return deps.repo.listByCustomer(input.customerId, filters);
}
```

---

## Authorization in Queries

Queries need authorization just like actions. Update your policies to handle both:

```typescript
// packages/core/src/orders/OrderPolicies.ts
import { AuthContext } from '../shared/authorization';
import { Order } from './Order';

export const OrderPolicies = {
  // For actions (receives entity)
  canCancel(ctx: AuthContext, order: Order): boolean {
    return order.customerId === ctx.userId || ctx.isAdmin;
  },

  // For queries (receives customerId from DTO)
  canView(ctx: AuthContext, orderCustomerId: string): boolean {
    return orderCustomerId === ctx.userId || ctx.isAdmin;
  },

  canViewCustomerOrders(ctx: AuthContext, customerId: string): boolean {
    return customerId === ctx.userId || ctx.isAdmin;
  },
};
```

---

## Repository Implementation

```typescript
// packages/infra/src/orders/OrderRepositoryMongo.ts
import { Model } from 'mongoose';
import { Order } from '@packages/core/orders/Order';
import { OrderRepository, OrderFilters } from '@packages/core/orders/OrderRepository';
import { OrderDetails, OrderSummary } from '@packages/core/orders/OrderReadModels';
import { OrderModel, IOrder } from './models/OrderModel';

export class OrderRepositoryMongo implements OrderRepository {
  constructor(private model: Model<IOrder> = OrderModel) {}

  // === Writes ===
  async save(order: Order): Promise<void> {
    await this.model.findOneAndUpdate(
      { _id: order.id },
      {
        customerId: order.customerId,
        items: order.items,
        status: order.status,
      },
      { upsert: true, new: true }
    );
  }

  // === Entity reads ===
  async findById(id: string): Promise<Order | null> {
    const doc = await this.model.findById(id).lean();
    if (!doc) return null;
    return this.toEntity(doc);
  }

  // === DTO reads (optimized aggregations) ===
  async getDetails(orderId: string): Promise<OrderDetails | null> {
    // Single aggregation with $lookup - no N+1 problem
    const result = await this.model.aggregate([
      { $match: { _id: orderId } },
      {
        $lookup: {
          from: 'customers',
          localField: 'customerId',
          foreignField: '_id',
          as: 'customerData'
        }
      },
      { $unwind: '$customerData' },
      {
        $lookup: {
          from: 'products',
          localField: 'items.productId',
          foreignField: '_id',
          as: 'productData'
        }
      },
      {
        $project: {
          id: '$_id',
          status: 1,
          createdAt: 1,
          customer: {
            id: '$customerData._id',
            name: '$customerData.name',
            email: '$customerData.email'
          },
          items: {
            $map: {
              input: '$items',
              as: 'item',
              in: {
                productId: '$$item.productId',
                quantity: '$$item.quantity',
                unitPrice: '$$item.price',
                lineTotal: { $multiply: ['$$item.quantity', '$$item.price'] },
                productName: {
                  $let: {
                    vars: {
                      product: {
                        $arrayElemAt: [
                          { $filter: {
                            input: '$productData',
                            cond: { $eq: ['$$this._id', '$$item.productId'] }
                          }},
                          0
                        ]
                      }
                    },
                    in: '$$product.name'
                  }
                }
              }
            }
          }
        }
      }
    ]);

    if (!result[0]) return null;
    return this.toOrderDetails(result[0]);
  }

  async listByCustomer(
    customerId: string,
    filters?: OrderFilters
  ): Promise<OrderSummary[]> {
    const result = await this.model.aggregate([
      { $match: { customerId } },
      {
        $lookup: {
          from: 'customers',
          localField: 'customerId',
          foreignField: '_id',
          as: 'customerData'
        }
      },
      { $unwind: '$customerData' },
      {
        $project: {
          id: '$_id',
          customerName: '$customerData.name',
          itemCount: { $size: '$items' },
          total: {
            $sum: {
              $map: {
                input: '$items',
                as: 'item',
                in: { $multiply: ['$$item.quantity', '$$item.price'] }
              }
            }
          },
          status: 1,
          createdAt: 1
        }
      },
      { $sort: { createdAt: -1 } },
      { $limit: filters?.limit ?? 20 },
      { $skip: filters?.offset ?? 0 }
    ]);

    return result.map(this.toOrderSummary);
  }

  // ... mapping methods
}
```

---

## When to Use CQRS

| Situation | Use CQRS? |
|-----------|-----------|
| Simple CRUD app | No |
| Read and write models are similar | No |
| Complex read queries with many lookups | **Yes** |
| Different scaling needs (reads >> writes) | **Yes** |
| UI needs denormalized/computed data | **Yes** |
| Multiple read representations of same data | **Yes** |

---

## The Spectrum

CQRS isn't all-or-nothing:

```
Simple                                              Complex
  │                                                    │
  ▼                                                    ▼

Same model     Separate       Separate        Separate
for both       interfaces     databases       event-sourced
    │              │              │               │
    └──────────────┴──────────────┴───────────────┘

              You are        Maybe           Probably
              here           someday         never
```

**Recommendation**: Start with **Separate interfaces** (same database, different contracts). Evolve only if needed.

---

## Updated Folder Structure

```
packages/core/src/orders/
├── Order.ts                    # Entity (write model)
├── OrderRepository.ts          # Combined read/write contract
├── OrderReadModels.ts          # DTOs for queries
├── OrderPolicies.ts            # Authorization policies
├── actions/                    # Commands (writes)
│   ├── createOrder.ts
│   ├── cancelOrder.ts
│   └── refundOrder.ts
├── queries/                    # Queries (reads)
│   ├── getOrderDetails.ts
│   └── listCustomerOrders.ts
└── index.ts                    # Public exports
```

---

## Exporting Queries

```typescript
// packages/core/src/orders/index.ts

// Entity
export { Order, OrderItem, OrderStatus } from './Order';

// Repository & Read Models
export { OrderRepository, OrderFilters } from './OrderRepository';
export { OrderDetails, OrderSummary } from './OrderReadModels';

// Policies
export { OrderPolicies } from './OrderPolicies';

// Actions (commands)
export { createOrder, CreateOrderDeps, CreateOrderInput } from './actions/createOrder';
export { cancelOrder, CancelOrderDeps, CancelOrderInput } from './actions/cancelOrder';

// Queries
export { getOrderDetails, GetOrderDetailsDeps, GetOrderDetailsInput } from './queries/getOrderDetails';
export { listCustomerOrders, ListCustomerOrdersDeps, ListCustomerOrdersInput } from './queries/listCustomerOrders';
```

---

## Next Steps

- [Authorization](./09-authorization.md) - Learn about policies for queries
- [Shared Package](./14-shared-package.md) - Share DTOs with frontend
- [Infrastructure](./07-infrastructure.md) - Implement the repository
