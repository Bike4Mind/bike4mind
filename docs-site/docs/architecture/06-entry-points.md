---
title: Entry Points
description: Entry points are how the outside world interacts with your application — HTTP, CLI, and queue handlers that call the same core actions.
sidebar_position: 7
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Entry Points

[← Back to README](./README.md)

---

## What Are Entry Points?

Entry points are how the outside world interacts with your application. They:
- Receive requests (HTTP, CLI commands, queue messages)
- Validate input
- Call core actions
- Return responses

**Key insight**: All entry points call the **same core actions**. Your business logic doesn't change based on how it's accessed.

```
┌─────────────────────────────────────────────────────────┐
│                     ENTRY POINTS                        │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐               │
│  │   API   │   │   CLI   │   │  Worker │               │
│  └────┬────┘   └────┬────┘   └────┬────┘               │
│       │             │             │                     │
│       └─────────────┼─────────────┘                     │
│                     ▼                                   │
│              ┌─────────────┐                            │
│              │    CORE     │                            │
│              │  (Actions)  │                            │
│              └─────────────┘                            │
└─────────────────────────────────────────────────────────┘
```

---

## Types of Entry Points

| Entry Point | Use Case | Location |
|-------------|----------|----------|
| HTTP API | Web/mobile clients, external integrations | `apps/client/pages/api/` |
| CLI | Admin tasks, scripts, debugging | `packages/cli/` |
| Worker | Background jobs, queue processing | `apps/worker/` |

---

## Wiring Dependencies in main.ts

The entry point's setup (or middleware factory for Next.js) is the **composition root** - the single place where all dependencies are constructed and connected. This is critical to the architecture.

### Why Wire at Startup?

| Benefit | Description |
|---------|-------------|
| **Shared resources** | Database pools, connections are created once and shared |
| **Fail-fast** | Bad configuration fails at startup, not on first request |
| **Testability** | Dependencies are injected, not constructed in handlers |
| **Visibility** | All wiring in one place - easy to understand the full picture |

### The Anti-Pattern: Wiring in Handlers

```typescript
// ❌ Bad - handler creates its own dependencies
const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    // Problems:
    // 1. New DB connection per request (connection pool exhaustion)
    // 2. Can't inject fakes for testing
    // 3. Fail on first request, not at startup
    // 4. Repeated wiring code in every handler
    const repository = new OrderRepositoryMongo();
    const mailer = new SendGridMailer(process.env.SENDGRID_KEY!);

    const order = await createOrder({ repository, mailer }, req.ctx, req.body);
    res.json(order);
  });
```

### The Pattern: Wire Once, Inject Everywhere

For Next.js, use a **singleton dependency container** with lazy initialization:

```typescript
// apps/client/server/dependencies.ts

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

### When to Use Factory vs Static Deps

| Situation | Pattern | Example |
|-----------|---------|---------|
| Feature has no cross-feature deps | Static deps object | `getCustomerDeps()` |
| Feature needs cross-feature data with auth | Dep factory | `getOrderDeps(ctx)` |
| System actions (workers, no auth) | Static deps object | `processOrderJob(orderDeps, payload)` |

### Wiring Checklist

1. [ ] Create shared resources (logger, mailer) once via singleton
2. [ ] Create repositories using shared resources
3. [ ] Bundle deps for features without cross-feature needs
4. [ ] Create dep factories for features with cross-feature needs
5. [ ] Pass deps/factories to handlers via imports

---

## HTTP API Entry Point (Next.js Pages API)

### Folder Structure

```
apps/
└── client/
    └── pages/
        └── api/
            ├── validators/              # Input validation schemas
            │   ├── orderValidators.ts
            │   └── userValidators.ts
            │
            ├── orders/                  # Order endpoints
            │   ├── index.ts             # POST /api/orders, GET /api/orders
            │   └── [id].ts              # GET /api/orders/:id, etc.
            │
            └── users/
                └── ...
```

### Example: Handler with baseApi Middleware

```typescript
// apps/client/pages/api/orders/index.ts
import { baseApi } from '@server/middlewares/baseApi';
import { createOrder, listOrders } from '@packages/core/orders';
import { OrderRepositoryMongo } from '@packages/infra/orders/OrderRepositoryMongo';
import { SendGridMailer } from '@packages/infra/shared/email/SendGridMailer';
import { createOrderSchema } from '../validators/orderValidators';

// Create dependencies (can also be done in middleware)
const deps = {
  repository: new OrderRepositoryMongo(),
  mailer: new SendGridMailer(process.env.SENDGRID_API_KEY!, 'orders@myapp.com'),
};

const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    // 1. Input validation
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    // 2. Call core action (pass ctx from auth middleware)
    const order = await createOrder(deps, req.ctx, parsed.data);
    res.status(201).json({
      id: order.id,
      total: order.total,
      status: order.status,
    });
  })
  .get(async (req, res) => {
    // List orders for the current user
    const orders = await listOrders(deps, req.ctx, {
      customerId: req.ctx.userId,
    });
    res.json(orders);
  });

export default handler;
```

### Example: Handler with Path Parameters

```typescript
// apps/client/pages/api/orders/[id].ts
import { baseApi } from '@server/middlewares/baseApi';
import { getOrder, cancelOrder } from '@packages/core/orders';
import { OrderRepositoryMongo } from '@packages/infra/orders/OrderRepositoryMongo';
import { SendGridMailer } from '@packages/infra/shared/email/SendGridMailer';
import { cancelOrderSchema } from '../validators/orderValidators';

const deps = {
  repository: new OrderRepositoryMongo(),
  mailer: new SendGridMailer(process.env.SENDGRID_API_KEY!, 'orders@myapp.com'),
};

const handler = baseApi({ auth: true })
  .get(async (req, res) => {
    const { id } = req.query;
    const order = await getOrder(deps, req.ctx, { orderId: id as string });
    res.json(order);
  })
  .post(async (req, res) => {
    // POST /api/orders/:id/cancel (or use action query param)
    const { id } = req.query;
    const parsed = cancelOrderSchema.safeParse({
      ...req.body,
      orderId: id,
    });

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const order = await cancelOrder(deps, req.ctx, parsed.data);
    res.json({
      id: order.id,
      status: order.status,
    });
  });

export default handler;
```

### Example: Input Validators

```typescript
// apps/client/pages/api/validators/orderValidators.ts
import { z } from 'zod';

export const createOrderSchema = z.object({
  customerId: z.string().uuid('Invalid customer ID format'),
  email: z.string().email('Invalid email address'),
  items: z.array(z.object({
    productId: z.string().uuid('Invalid product ID'),
    quantity: z.number().int().min(1, 'Quantity must be at least 1'),
    price: z.number().positive('Price must be positive')
  })).min(1, 'Order must have at least one item')
});

export const cancelOrderSchema = z.object({
  orderId: z.string().uuid('Invalid order ID'),
  email: z.string().email('Invalid email address'),
  reason: z.string().min(1, 'Reason is required').max(500, 'Reason too long')
});

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
export type CancelOrderRequest = z.infer<typeof cancelOrderSchema>;
```

### Example: Auth via baseApi Middleware

The `baseApi` middleware factory handles authentication and builds the AuthContext:

```typescript
// apps/client/server/middlewares/baseApi.ts
import { AuthContext } from '@packages/core/shared/authorization';

export interface BaseApiOptions {
  auth?: boolean;
}

export function baseApi(options: BaseApiOptions = {}) {
  return {
    post: (handler: Handler) => createHandler('POST', handler, options),
    get: (handler: Handler) => createHandler('GET', handler, options),
    put: (handler: Handler) => createHandler('PUT', handler, options),
    delete: (handler: Handler) => createHandler('DELETE', handler, options),
  };
}

function createHandler(method: string, handler: Handler, options: BaseApiOptions) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== method) {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (options.auth) {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return res.status(401).json({ error: 'Missing authentication token' });
      }

      const user = await verifyToken(token);
      if (!user) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      // Build auth context for core
      req.ctx = {
        userId: user.id,
        roles: user.roles,
        isAdmin: user.roles.includes('admin'),
      } satisfies AuthContext;
    }

    try {
      await handler(req, res);
    } catch (error) {
      handleError(error, res);
    }
  };
}

function handleError(err: unknown, res: NextApiResponse) {
  if (err instanceof Error) {
    if (err.name === 'NotFoundError') {
      return res.status(404).json({ error: err.message });
    }
    if (err.name === 'BusinessError' || err.name === 'InvariantError') {
      return res.status(422).json({ error: err.message });
    }
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
```

---

## CLI Entry Point

### Folder Structure

```
apps/
└── cli/
    └── src/
        ├── commands/
        │   ├── createOrder.ts
        │   ├── cancelOrder.ts
        │   └── listOrders.ts
        │
        └── main.ts
```

### Example: CLI Command

```typescript
// packages/cli/src/commands/createOrder.ts
import { createOrder, CreateOrderInput } from '@packages/core/orders';
import { CreateOrderDeps } from '@packages/core/orders';
import { AuthContext } from '@packages/core/shared/authorization';

interface CreateOrderOptions {
  customerId: string;
  email: string;
  items: string; // JSON string of items
}

export async function createOrderCommand(
  deps: CreateOrderDeps,
  ctx: AuthContext,
  options: CreateOrderOptions
) {
  try {
    // 1. Parse and validate input
    const items = JSON.parse(options.items);
    const input: CreateOrderInput = {
      customerId: options.customerId,
      email: options.email,
      items
    };

    // 2. Call core action (same as HTTP API!)
    const order = await createOrder(deps, ctx, input);

    // 3. Output result
    console.log(`✓ Order created: ${order.id}`);
    console.log(`  Total: $${order.total}`);
    console.log(`  Status: ${order.status}`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`✗ Failed: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
```

### Example: CLI Main

```typescript
// packages/cli/src/main.ts
import { Command } from 'commander';
import { createOrderCommand } from './commands/createOrder';
import { cancelOrderCommand } from './commands/cancelOrder';

// Infrastructure (same setup as server)
import { OrderRepositoryMongo } from '@packages/infra/orders/OrderRepositoryMongo';
import { SendGridMailer } from '@packages/infra/shared/email/SendGridMailer';
import { AuthContext } from '@packages/core/shared/authorization';

const program = new Command();

// Wire dependencies (same as server!)
const deps = {
  repository: new OrderRepositoryMongo(),
  mailer: new SendGridMailer(process.env.SENDGRID_API_KEY!, 'orders@myapp.com')
};

// CLI runs as admin (or load from config/env)
const ctx: AuthContext = {
  userId: 'cli-admin',
  roles: ['admin'],
  isAdmin: true,
};

program
  .name('myapp')
  .description('CLI for managing orders')
  .version('1.0.0');

program
  .command('create-order')
  .description('Create a new order')
  .requiredOption('--customer-id <id>', 'Customer ID')
  .requiredOption('--email <email>', 'Customer email')
  .requiredOption('--items <json>', 'Order items as JSON')
  .action((options) => createOrderCommand(deps, ctx, options));

program
  .command('cancel-order')
  .description('Cancel an existing order')
  .requiredOption('--order-id <id>', 'Order ID')
  .requiredOption('--email <email>', 'Customer email')
  .requiredOption('--reason <reason>', 'Cancellation reason')
  .action((options) => cancelOrderCommand(deps, ctx, options));

program.parse();
```

---

## Worker Entry Point

### Folder Structure

```
apps/
└── worker/
    └── src/
        ├── jobs/
        │   ├── processOrder.ts
        │   ├── sendReminder.ts
        │   └── generateReport.ts
        │
        └── main.ts
```

### Example: Job Handler

```typescript
// apps/worker/src/jobs/processOrder.ts
import { createOrder, CreateOrderInput } from '@packages/core/orders';
import { CreateOrderDeps } from '@packages/core/orders';
import { AuthContext } from '@packages/core/shared/authorization';

interface ProcessOrderPayload {
  customerId: string;
  email: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
}

export async function processOrderJob(
  deps: CreateOrderDeps,
  ctx: AuthContext,
  payload: ProcessOrderPayload
) {
  // 1. Prepare input
  const input: CreateOrderInput = {
    customerId: payload.customerId,
    email: payload.email,
    items: payload.items
  };

  // 2. Call core action (same as HTTP API and CLI!)
  const order = await createOrder(deps, ctx, input);

  console.log(`[Worker] Order ${order.id} processed successfully`);
  return { orderId: order.id, status: order.status };
}
```

### Example: Worker Main

```typescript
// apps/worker/src/main.ts
import { Worker } from 'bullmq';
import { processOrderJob } from './jobs/processOrder';
import { sendReminderJob } from './jobs/sendReminder';

// Infrastructure (same setup as server!)
import { OrderRepositoryMongo } from '@packages/infra/orders/OrderRepositoryMongo';
import { SendGridMailer } from '@packages/infra/shared/email/SendGridMailer';
import { AuthContext } from '@packages/core/shared/authorization';

// Wire dependencies (same as server and CLI!)
const deps = {
  repository: new OrderRepositoryMongo(),
  mailer: new SendGridMailer(process.env.SENDGRID_API_KEY!, 'orders@myapp.com')
};

// Workers run as system user
const ctx: AuthContext = {
  userId: 'system-worker',
  roles: ['system'],
  isAdmin: true,
};

// Create worker
const worker = new Worker('orders', async (job) => {
  switch (job.name) {
    case 'process-order':
      return processOrderJob(deps, ctx, job.data);
    case 'send-reminder':
      return sendReminderJob(deps, ctx, job.data);
    default:
      throw new Error(`Unknown job: ${job.name}`);
  }
}, {
  connection: { host: 'localhost', port: 6379 }
});

worker.on('completed', (job) => {
  console.log(`[Worker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed:`, err.message);
});

console.log('[Worker] Listening for jobs...');
```

---

## The Pattern

All entry points follow the same pattern:

```
1. RECEIVE    - Get input (HTTP body, CLI args, job payload)
2. VALIDATE   - Validate and parse input
3. CALL       - Call core action with dependencies
4. RESPOND    - Return result (HTTP response, console output, job result)
```

This is why your core actions are **reusable** - they don't know or care how they're being called.

---

## What Entry Points Should NOT Do

| Don't | Why |
|-------|-----|
| Business logic | That belongs in actions |
| Database queries | That belongs in infrastructure |
| Send emails directly | That belongs in actions |
| Domain validation | That belongs in entities |

Entry points are just thin adapters between the outside world and your core.

---

## Import Rules

Entry points can import from:
- ✅ `@packages/core` (to use actions and types)
- ✅ `@packages/infra` (to wire dependencies)
- ✅ Framework libraries (Next.js, Commander, BullMQ)

---

## Framework-Specific Examples

The patterns above use Next.js Pages API as the baseline. For other frameworks, see:

| Framework | Example |
|-----------|---------|
| Next.js (App Router) | [examples/nextjs-api.md](./examples/nextjs-api.md) |

---

## Next Steps

- [Dependency Management](./17-dependency-management.md) - Learn about organizing dependencies as your app grows
- [Authorization](./09-authorization.md) - Learn about building auth context
- [Validation](./10-validation.md) - Learn about the validation strategy
- [Testing](./15-testing.md) - Learn about testing
- [Rules & Guidelines](./08-rules-and-guidelines.md) - Learn about import rules
