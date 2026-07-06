---
title: Authorization
description: "Authorization answers: \"Can this user perform this action?\" — checked in Core via policies and rules."
sidebar_position: 10
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Authorization

[← Back to README](./README.md)

---

## Overview

Authorization answers: **"Can this user perform this action?"**

| Concern | Layer | Responsibility |
|---------|-------|----------------|
| **Authentication** | Entry Points | Verify identity (tokens, sessions) |
| **Authorization** | Core | Check permissions (policies, rules) |

---

## Auth Context

The `AuthContext` represents the authenticated user's identity and permissions. Entry points create it, actions consume it.

```typescript
// packages/core/src/shared/authorization/AuthContext.ts
export interface AuthContext {
  userId: string;
  roles: string[];
  isAdmin: boolean;
}
```

### Building Auth Context at Entry Points

```typescript
// apps/client/server/middlewares/baseApi.ts
import { AuthContext } from '@packages/core/shared/authorization';

export function baseApi(options: BaseApiOptions = {}) {
  return {
    post: (handler: Handler) => createHandler('POST', handler, options),
    get: (handler: Handler) => createHandler('GET', handler, options),
    // ... other methods
  };
}

function createHandler(method: string, handler: Handler, options: BaseApiOptions) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (options.auth) {
      const token = req.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return res.status(401).json({ error: 'Missing authentication token' });
      }

      const user = await verifyToken(token);  // Your token verification logic

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
```

---

## Policies

Policies are pure functions that encode authorization rules. They live in core and are grouped by feature.

### Folder Structure

```
packages/core/src/
├── shared/
│   └── authorization/
│       ├── AuthContext.ts       # Auth context interface
│       └── index.ts             # Exports
│
├── orders/
│   ├── Order.ts
│   ├── OrderRepository.ts
│   ├── OrderPolicies.ts         # Order authorization policies
│   └── actions/
│
└── users/
    ├── User.ts
    ├── UserRepository.ts
    ├── UserPolicies.ts          # User authorization policies
    └── actions/
```

### Example: Order Policies

```typescript
// packages/core/src/orders/OrderPolicies.ts
import { AuthContext } from '../shared/authorization';
import { Order } from './Order';

export const OrderPolicies = {
  canView(ctx: AuthContext, order: Order): boolean {
    return order.customerId === ctx.userId || ctx.isAdmin;
  },

  canCancel(ctx: AuthContext, order: Order): boolean {
    return order.customerId === ctx.userId || ctx.isAdmin;
  },

  canRefund(ctx: AuthContext, order: Order): boolean {
    return ctx.isAdmin;
  },

  canViewAll(ctx: AuthContext): boolean {
    return ctx.isAdmin;
  },
};
```

### Example: User Policies

```typescript
// packages/core/src/users/UserPolicies.ts
import { AuthContext } from '../shared/authorization';
import { User } from './User';

export const UserPolicies = {
  canView(ctx: AuthContext, user: User): boolean {
    return user.id === ctx.userId || ctx.isAdmin;
  },

  canUpdate(ctx: AuthContext, user: User): boolean {
    return user.id === ctx.userId || ctx.isAdmin;
  },

  canDelete(ctx: AuthContext, user: User): boolean {
    return ctx.isAdmin;
  },

  canListAll(ctx: AuthContext): boolean {
    return ctx.isAdmin;
  },
};
```

---

## Using Policies in Actions

Actions receive `AuthContext` and use policies to check permissions:

```typescript
// packages/core/src/orders/actions/cancelOrder.ts
import { Order } from '../Order';
import { OrderRepository } from '../OrderRepository';
import { OrderPolicies } from '../OrderPolicies';
import { AuthContext } from '../../shared/authorization';
import { NotFoundError, BusinessError } from '../../shared/errors';

export interface CancelOrderDeps {
  repository: OrderRepository;
}

export interface CancelOrderInput {
  orderId: string;
  reason: string;
}

export async function cancelOrder(
  deps: CancelOrderDeps,
  ctx: AuthContext,
  input: CancelOrderInput
): Promise<Order> {
  // 1. Load
  const order = await deps.repository.findById(input.orderId);
  if (!order) {
    throw new NotFoundError('Order not found');
  }

  // 2. Authorize
  if (!OrderPolicies.canCancel(ctx, order)) {
    throw new BusinessError('Not authorized to cancel this order');
  }

  // 3. Execute (entity validates state)
  order.cancel(input.reason);

  // 4. Persist
  await deps.repository.save(order);

  return order;
}
```

---

## Action Pattern with Authorization

The updated action flow:

```
1. LOAD       - Fetch required data
2. AUTHORIZE  - Check permissions using policies
3. VALIDATE   - Business validation (optional)
4. EXECUTE    - State change (entity validates invariants)
5. PERSIST    - Save changes
6. SIDE EFFECTS - External notifications
```

```typescript
export async function refundOrder(
  deps: RefundOrderDeps,
  ctx: AuthContext,
  input: RefundOrderInput
): Promise<Order> {
  // 1. LOAD
  const order = await deps.repository.findById(input.orderId);
  if (!order) {
    throw new NotFoundError('Order not found');
  }

  // 2. AUTHORIZE
  if (!OrderPolicies.canRefund(ctx, order)) {
    throw new BusinessError('Not authorized to refund orders');
  }

  // 3. VALIDATE (business rules)
  if (order.status !== 'paid') {
    throw new BusinessError('Can only refund paid orders');
  }

  // 4. EXECUTE
  const refundResult = await deps.paymentGateway.refund(
    order.paymentId,
    order.total
  );
  if (!refundResult.success) {
    throw new BusinessError(`Refund failed: ${refundResult.error}`);
  }
  order.markRefunded(refundResult.transactionId);

  // 5. PERSIST
  await deps.repository.save(order);

  // 6. SIDE EFFECTS
  await deps.mailer.send(
    input.email,
    'Refund Processed',
    `Your refund of $${order.total} has been processed.`
  );

  return order;
}
```

---

## Entry Points Pass Context

```typescript
// apps/client/pages/api/orders/[id].ts
import { baseApi } from '@server/middlewares/baseApi';
import { cancelOrder } from '@packages/core/orders';
import { OrderRepositoryMongo } from '@packages/infra/orders/OrderRepositoryMongo';
import { cancelOrderSchema } from '../validators/orderValidators';

const deps = {
  repository: new OrderRepositoryMongo(),
};

const handler = baseApi({ auth: true })
  .post(async (req, res) => {
    const { id } = req.query;
    const parsed = cancelOrderSchema.safeParse({
      orderId: id,
      reason: req.body.reason,
    });

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const order = await cancelOrder(
      deps,
      req.ctx,        // AuthContext from middleware
      parsed.data     // Validated input
    );
    res.json({ id: order.id, status: order.status });
  });

export default handler;
```

---

## Testing Policies

Policies are pure functions, making them easy to test:

```typescript
// packages/core/src/orders/OrderPolicies.test.ts
import { OrderPolicies } from './OrderPolicies';
import { Order } from './Order';
import { AuthContext } from '../shared/authorization';

describe('OrderPolicies', () => {
  const customerCtx: AuthContext = {
    userId: 'user-1',
    roles: ['customer'],
    isAdmin: false,
  };

  const adminCtx: AuthContext = {
    userId: 'admin-1',
    roles: ['admin'],
    isAdmin: true,
  };

  const otherUserCtx: AuthContext = {
    userId: 'user-2',
    roles: ['customer'],
    isAdmin: false,
  };

  describe('canCancel', () => {
    it('allows owner to cancel', () => {
      const order = new Order('o1', 'user-1', []);
      expect(OrderPolicies.canCancel(customerCtx, order)).toBe(true);
    });

    it('allows admin to cancel any order', () => {
      const order = new Order('o1', 'user-1', []);
      expect(OrderPolicies.canCancel(adminCtx, order)).toBe(true);
    });

    it('denies non-owner from cancelling', () => {
      const order = new Order('o1', 'user-1', []);
      expect(OrderPolicies.canCancel(otherUserCtx, order)).toBe(false);
    });
  });

  describe('canRefund', () => {
    it('only allows admin to refund', () => {
      const order = new Order('o1', 'user-1', []);
      expect(OrderPolicies.canRefund(customerCtx, order)).toBe(false);
      expect(OrderPolicies.canRefund(adminCtx, order)).toBe(true);
    });
  });
});
```

---

## Complex Authorization

For more complex scenarios (team access, resource hierarchies), extend the pattern:

### Team-Based Access

```typescript
// packages/core/src/shared/authorization/AuthContext.ts
export interface AuthContext {
  userId: string;
  roles: string[];
  isAdmin: boolean;
  teamIds: string[];  // Teams the user belongs to
}

// packages/core/src/projects/ProjectPolicies.ts
export const ProjectPolicies = {
  canView(ctx: AuthContext, project: Project): boolean {
    return (
      project.ownerId === ctx.userId ||
      ctx.teamIds.includes(project.teamId) ||
      ctx.isAdmin
    );
  },

  canEdit(ctx: AuthContext, project: Project): boolean {
    return (
      project.ownerId === ctx.userId ||
      (ctx.teamIds.includes(project.teamId) && project.isEditable) ||
      ctx.isAdmin
    );
  },
};
```

### Role-Based Permissions

```typescript
// packages/core/src/shared/authorization/AuthContext.ts
export interface AuthContext {
  userId: string;
  roles: string[];
  permissions: string[];  // Fine-grained permissions
  isAdmin: boolean;
}

// packages/core/src/reports/ReportPolicies.ts
export const ReportPolicies = {
  canGenerate(ctx: AuthContext): boolean {
    return ctx.permissions.includes('reports:generate') || ctx.isAdmin;
  },

  canExport(ctx: AuthContext): boolean {
    return ctx.permissions.includes('reports:export') || ctx.isAdmin;
  },
};
```

---

## Summary

| Concept | Location | Purpose |
|---------|----------|---------|
| `AuthContext` | `core/shared/authorization/` | Identity and permissions |
| Policies | `core/{feature}/` | Authorization rules |
| Context creation | Entry points (middleware) | Build context from token |
| Permission checks | Actions | Enforce policies |

---

## Next Steps

- [CQRS and Read Models](./11-cqrs-and-read-models.md) - Learn about authorization in queries
- [Actions](./05-actions.md) - Learn about action signatures
- [Entry Points](./06-entry-points.md) - Learn about authentication middleware
- [Testing](./15-testing.md) - Learn about testing with fakes
