---
title: Next.js API Routes (App Router)
description: How to adapt the wiring pattern for Next.js App Router API routes using a singleton dependency container with lazy initialization.
sidebar_position: 2
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Next.js API Routes (App Router)

[← Back to Examples](./README.md) | [← Back to Entry Points](../06-entry-points.md)

---

## Overview

Next.js App Router uses file-based routing with no single `main.ts` entry point. This example shows how to adapt the wiring pattern for Next.js App Router API routes.

**Key adaptation**: Use a **singleton dependency container** with lazy initialization instead of startup wiring.

**Note**: The main architecture documentation uses Next.js Pages API as the baseline. This document covers the App Router variant.

---

## Folder Structure

```
src/
├── app/
│   └── api/
│       ├── orders/
│       │   ├── route.ts              # POST /api/orders
│       │   └── [id]/
│       │       └── cancel/
│       │           └── route.ts      # POST /api/orders/:id/cancel
│       └── customers/
│           └── route.ts
│
├── lib/
│   ├── dependencies.ts               # Singleton container + factories
│   ├── auth.ts                       # Auth context helper
│   ├── api-utils.ts                  # Error handling
│   └── validators/
│       └── orderValidators.ts
│
└── packages/                         # Same as main architecture
    ├── core/
    └── infra/
```

---

## 1. Dependency Container (Singleton)

The core adaptation - module-level singleton with lazy initialization.

```typescript
// src/lib/dependencies.ts
import { OrderRepositoryMongo } from '@packages/infra/orders/OrderRepositoryMongo';
import { CustomerRepositoryMongo } from '@packages/infra/customers/CustomerRepositoryMongo';
import { SendGridMailer } from '@packages/infra/shared/email/SendGridMailer';
import { PinoLogger } from '@packages/infra/shared/logging/PinoLogger';
import { getCustomer } from '@packages/core/customers';
import { AuthContext } from '@packages/core/shared/authorization';

// ============================================
// SINGLETON CONTAINER
// Module-level = cached by Node.js across requests
// ============================================

let _deps: AppDependencies | null = null;

export interface AppDependencies {
  logger: PinoLogger;
  mailer: SendGridMailer;
  orderRepository: OrderRepositoryMongo;
  customerRepository: CustomerRepositoryMongo;
}

// Lazy initialization - created on first request, reused after
export function getDependencies(): AppDependencies {
  if (_deps) return _deps;

  console.log('[deps] Initializing dependencies...');

  const logger = new PinoLogger();
  const mailer = new SendGridMailer(
    process.env.SENDGRID_API_KEY!,
    'noreply@myapp.com'
  );

  const orderRepository = new OrderRepositoryMongo();
  const customerRepository = new CustomerRepositoryMongo();

  _deps = {
    logger,
    mailer,
    orderRepository,
    customerRepository,
  };

  return _deps;
}

// ============================================
// FEATURE DEP FACTORIES
// ============================================

export function getCustomerDeps() {
  const { customerRepository, mailer, logger } = getDependencies();
  return { repository: customerRepository, mailer, logger };
}

export function getOrderDeps(ctx: AuthContext) {
  const { orderRepository, mailer, logger } = getDependencies();
  const customerDeps = getCustomerDeps();

  return {
    repository: orderRepository,
    mailer,
    logger,
    // Cross-feature dependency with auth context bound
    getCustomer: async (customerId: string) => {
      const customer = await getCustomer(customerDeps, ctx, { customerId });
      if (!customer) return null;
      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        isInGoodStanding: customer.status === 'active',
        creditLimit: customer.creditLimit,
      };
    },
  };
}
```

---

## 2. Auth Context Helper

```typescript
// src/lib/auth.ts
import { NextRequest } from 'next/server';
import { AuthContext } from '@packages/core/shared/authorization';
import { verifyToken } from './jwt'; // your JWT lib

export async function getAuthContext(
  request: NextRequest
): Promise<AuthContext | null> {
  const token = request.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;

  const user = await verifyToken(token);
  if (!user) return null;

  return {
    userId: user.id,
    roles: user.roles,
    isAdmin: user.roles.includes('admin'),
    requestId: request.headers.get('x-request-id') || crypto.randomUUID(),
  };
}
```

---

## 3. Error Handler

```typescript
// src/lib/api-utils.ts
import { NextResponse } from 'next/server';

export function handleError(error: unknown) {
  if (error instanceof Error) {
    switch (error.name) {
      case 'NotFoundError':
        return NextResponse.json({ error: error.message }, { status: 404 });
      case 'BusinessError':
      case 'InvariantError':
        return NextResponse.json({ error: error.message }, { status: 422 });
    }
  }

  console.error('Unhandled error:', error);
  return NextResponse.json(
    { error: 'Internal server error' },
    { status: 500 }
  );
}
```

---

## 4. API Routes (App Router)

### Create Order

```typescript
// src/app/api/orders/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createOrder } from '@packages/core/orders';
import { getOrderDeps } from '@/lib/dependencies';
import { getAuthContext } from '@/lib/auth';
import { handleError } from '@/lib/api-utils';
import { createOrderSchema } from '@/lib/validators/orderValidators';

export async function POST(request: NextRequest) {
  // 1. Get auth context from request
  const ctx = await getAuthContext(request);
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Validate input
  const body = await request.json();
  const parsed = createOrderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // 3. Get deps (singleton + context-bound cross-feature deps)
  const deps = getOrderDeps(ctx);

  // 4. Call core action
  try {
    const order = await createOrder(deps, ctx, parsed.data);
    return NextResponse.json({ id: order.id }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
```

### Cancel Order

```typescript
// src/app/api/orders/[id]/cancel/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cancelOrder } from '@packages/core/orders';
import { getOrderDeps } from '@/lib/dependencies';
import { getAuthContext } from '@/lib/auth';
import { handleError } from '@/lib/api-utils';
import { cancelOrderSchema } from '@/lib/validators/orderValidators';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const ctx = await getAuthContext(request);
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const parsed = cancelOrderSchema.safeParse({ ...body, orderId: params.id });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const deps = getOrderDeps(ctx);

  try {
    const order = await cancelOrder(deps, ctx, parsed.data);
    return NextResponse.json({ id: order.id, status: order.status });
  } catch (error) {
    return handleError(error);
  }
}
```

---

## 5. Input Validators

```typescript
// src/lib/validators/orderValidators.ts
import { z } from 'zod';

export const createOrderSchema = z.object({
  customerId: z.string().uuid('Invalid customer ID format'),
  email: z.string().email('Invalid email address'),
  items: z
    .array(
      z.object({
        productId: z.string().uuid('Invalid product ID'),
        quantity: z.number().int().min(1, 'Quantity must be at least 1'),
        price: z.number().positive('Price must be positive'),
      })
    )
    .min(1, 'Order must have at least one item'),
});

export const cancelOrderSchema = z.object({
  orderId: z.string().uuid('Invalid order ID'),
  reason: z.string().min(1, 'Reason is required').max(500, 'Reason too long'),
});

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
export type CancelOrderRequest = z.infer<typeof cancelOrderSchema>;
```

---

## Key Differences: Pages API vs App Router

| Aspect | Pages API | App Router |
|--------|-----------|------------|
| Wiring location | `server/dependencies.ts` singleton | `lib/dependencies.ts` singleton |
| Route files | `pages/api/*.ts` with default export | `app/api/*/route.ts` with named exports |
| Request type | `NextApiRequest` | `NextRequest` |
| Response type | `NextApiResponse` | `NextResponse` |
| Params access | `req.query.id` | `params.id` via route context |
| Method handling | Check `req.method` or middleware | Export `GET`, `POST`, etc. |

---

## Serverless Considerations

When deploying to Vercel or other serverless platforms:

| Consideration | Recommendation |
|---------------|----------------|
| Connection pooling | Reuse via singleton pattern - Vercel caches modules across warm invocations |
| Cold starts | Consider connection warming or external poolers |
| MongoDB | Use connection pooling with proper max connections |
| Module caching | Singleton pattern works - module is cached across warm invocations |

---

## Optional: Route Handler Wrapper

Reduce boilerplate with a wrapper function:

```typescript
// src/lib/api-utils.ts
import { NextRequest, NextResponse } from 'next/server';
import { AuthContext } from '@packages/core/shared/authorization';
import { getAuthContext } from './auth';

type AuthenticatedHandler<T = unknown> = (
  request: NextRequest,
  ctx: AuthContext,
  params: T
) => Promise<NextResponse>;

export function withAuth<T = unknown>(handler: AuthenticatedHandler<T>) {
  return async (request: NextRequest, context: { params: T }) => {
    const ctx = await getAuthContext(request);
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
      return await handler(request, ctx, context.params);
    } catch (error) {
      return handleError(error);
    }
  };
}
```

Usage:

```typescript
// src/app/api/orders/route.ts
import { withAuth } from '@/lib/api-utils';
import { getOrderDeps } from '@/lib/dependencies';
import { createOrder } from '@packages/core/orders';

export const POST = withAuth(async (request, ctx) => {
  const body = await request.json();
  const parsed = createOrderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const deps = getOrderDeps(ctx);
  const order = await createOrder(deps, ctx, parsed.data);
  return NextResponse.json({ id: order.id }, { status: 201 });
});
```
