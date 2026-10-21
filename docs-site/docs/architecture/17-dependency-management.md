---
title: Dependency Management
description: This architecture uses manual dependency injection — dependencies are created at startup and passed explicitly to actions.
sidebar_position: 18
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Dependency Management

[← Back to README](./README.md)

---

## Overview

This architecture uses **manual dependency injection** - dependencies are created at startup and passed explicitly to actions. No DI container needed.

```typescript
// The pattern: create deps, pass to actions
const deps = { repository, mailer, logger };
const order = await createOrder(deps, ctx, input);
```

---

## Basic Wiring

For small applications, create all dependencies in server startup or shared modules:

```typescript
// apps/client/server/dependencies.ts
import mongoose from 'mongoose';
import { OrderRepositoryMongo } from '@packages/infra/orders/OrderRepositoryMongo';
import { SendGridMailer } from '@packages/infra/shared/email/SendGridMailer';
import { PinoLogger } from '@packages/infra/shared/logging/PinoLogger';

// 1. Connect to database
await mongoose.connect(process.env.MONGODB_URI!);

// 2. Create implementations
const orderRepository = new OrderRepositoryMongo();
const mailer = new SendGridMailer(process.env.SENDGRID_API_KEY!, 'orders@myapp.com');
const logger = new PinoLogger();

// 3. Export bundled dependencies
export const deps = { orderRepository, mailer, logger };
```

This works well for apps with 5-10 dependencies.

---

## Scaling Up: Grouped Dependencies

As your app grows, group dependencies by feature or layer:

```typescript
// apps/client/server/dependencies.ts
import mongoose from 'mongoose';

// Group by layer
const repositories = {
  order: new OrderRepositoryMongo(),
  customer: new CustomerRepositoryMongo(),
  product: new ProductRepositoryMongo(),
};

const services = {
  mailer: new SendGridMailer(process.env.SENDGRID_API_KEY!, 'noreply@myapp.com'),
  paymentGateway: new StripePaymentGateway(process.env.STRIPE_SECRET_KEY!),
};

const shared = {
  logger: new PinoLogger(),
  tx: new MongoTransactionManager(mongoose.connection),
};

export const deps = { repositories, services, shared };
```

| Approach | Best For |
|----------|----------|
| Group by layer | Shared infrastructure across features |
| Group by feature | Clear feature boundaries, independent scaling |

---

## Request-Scoped Dependencies

Some dependencies need request context. Use **factory functions**:

```typescript
// apps/client/server/dependencies.ts
export interface SharedDeps {
  orderRepository: OrderRepository;
  customerRepository: CustomerRepository;
  mailer: Mailer;
  logger: Logger;
}

export interface OrderActionDeps {
  repository: OrderRepository;
  mailer: Mailer;
  logger: Logger;
  getCustomer: (customerId: string) => Promise<CustomerData | null>;
}

// Factory creates deps bound to request context
export function createOrderActionDeps(shared: SharedDeps, ctx: AuthContext): OrderActionDeps {
  return {
    repository: shared.orderRepository,
    mailer: shared.mailer,
    logger: shared.logger,
    getCustomer: async (customerId: string) => {
      const customer = await getCustomer({ repository: shared.customerRepository }, ctx, { customerId });
      if (!customer) return null;
      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        isInGoodStanding: customer.isInGoodStanding(),
      };
    },
  };
}
```

### Using the Factory in Handlers

```typescript
// apps/client/pages/api/orders/index.ts
import { baseApi } from '@server/middlewares/baseApi';
import { createOrder } from '@packages/core/orders';
import { createOrderActionDeps, shared } from '@server/dependencies';

const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const deps = createOrderActionDeps(shared, req.ctx);
    const order = await createOrder(deps, req.ctx, req.body);
    res.status(201).json({ id: order.id });
  });

export default handler;
```

---

## Lazy Initialization

For expensive resources, defer initialization until first use:

```typescript
// apps/client/server/infrastructure.ts
import mongoose from 'mongoose';

let dbConnected = false;

export async function ensureDbConnected() {
  if (!dbConnected) {
    await mongoose.connect(process.env.MONGODB_URI!);
    dbConnected = true;
    console.log('Database connected');
  }
}
```

| Scenario | Use Lazy? |
|----------|-----------|
| Database connection | Yes - defer until first query |
| External API clients | Yes - defer until first call |
| Logger | No - needed immediately |
| In-memory caches | No - cheap to create |

---

## Testing Configurations

Create different dependency configurations for different environments:

```typescript
// apps/client/server/dependencies.ts
export interface AppDeps {
  orderRepository: OrderRepository;
  mailer: Mailer;
  logger: Logger;
}

export async function createProductionDeps(): Promise<AppDeps> {
  await mongoose.connect(process.env.MONGODB_URI!);
  return {
    orderRepository: new OrderRepositoryMongo(),
    mailer: new SendGridMailer(process.env.SENDGRID_API_KEY!, 'orders@myapp.com'),
    logger: new PinoLogger(),
  };
}

export async function createDevelopmentDeps(): Promise<AppDeps> {
  await mongoose.connect(process.env.MONGODB_URI!);
  return {
    orderRepository: new OrderRepositoryMongo(),
    mailer: new ConsoleMailer(),  // Logs emails instead of sending
    logger: new PinoLogger({ level: 'debug' }),
  };
}

export function createTestDeps(): AppDeps {
  return {
    orderRepository: new FakeOrderRepository(),
    mailer: new FakeMailer(),
    logger: new FakeLogger(),
  };
}
```

### Usage

```typescript
// In production/development
const deps = process.env.NODE_ENV === 'production'
  ? await createProductionDeps()
  : await createDevelopmentDeps();

// In tests
const deps = createTestDeps();
```

---

## Folder Structure

```
apps/client/
|- pages/api/                 # API routes
|   |- orders/
|   |   |- index.ts           # Handler, uses deps
|   |   +- [id].ts
|   +- validators/
|       +- orderValidators.ts
|
|- server/
|   |- dependencies.ts        # Dep types and factory functions
|   |- infrastructure.ts      # Lazy infrastructure (optional)
|   +- middlewares/
|       +- baseApi.ts
|
+- test/
    +- fakes/                 # Test implementations
```

---

## Summary

| Pattern | When to Use |
|---------|-------------|
| **Single deps object** | Small apps (`< 10` deps) |
| **Grouped deps** | Growing apps, clearer organization |
| **Factory functions** | Request-scoped dependencies |
| **Lazy initialization** | Expensive resources, optional features |
| **Environment configs** | Different deps for test/dev/prod |

See [Rules & Guidelines](./08-rules-and-guidelines.md) for anti-patterns to avoid.

---

## Next Steps

- [Entry Points](./06-entry-points.md) - HTTP, CLI, and Worker setup
- [Actions](./05-actions.md) - How actions receive dependencies
- [Cross-Feature Communication](./13-cross-feature-communication.md) - Factory functions for cross-feature deps
- [Testing](./15-testing.md) - Testing with fakes
