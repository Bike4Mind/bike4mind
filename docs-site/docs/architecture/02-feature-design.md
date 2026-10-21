---
title: Feature Design
description: "Three feature types: Resource (owns data), Orchestration (coordinates features), Computation (calculates, no persistence)."
sidebar_position: 3
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Feature Design

[← Back to README](./README.md)

<!-- SUMMARY -->
Three feature types: Resource (owns data, has entity+repository), Orchestration (coordinates features, no repository), Computation (calculates, no persistence).
Ask: Does it own data? -> Resource. Does it coordinate? -> Orchestration. Does it calculate? -> Computation.
Only Resource features need repositories. Cross-feature data uses function dependencies.
<!-- /SUMMARY -->

---

## Feature Types

Not all features need repositories. Identify the type first:

| Feature Type | Has Entity | Has Repository | Purpose |
|--------------|------------|----------------|---------|
| **Resource** | Yes | Yes | Owns and persists domain data |
| **Orchestration** | No | No | Coordinates actions across features |
| **Computation** | No | No | Performs calculations |

---

## 1. Resource Features

Features that **own data** and manage its lifecycle. Most common type.

**Examples:** `orders`, `customers`, `products`, `invoices`, `users`

**Structure:**
```
packages/core/src/orders/
|- Order.ts              # Entity
|- OrderRepository.ts    # Contract
|- OrderPolicies.ts      # Authorization
|- actions/
|   |- createOrder.ts
|   +- cancelOrder.ts
+- index.ts
```

**When to create:** Data needs persistence, has lifecycle, has business rules.

---

## 2. Orchestration Features

Features that **coordinate work** across multiple resource features.

**Examples:** `checkout`, `onboarding`, `order-fulfillment`, `account-closure`

**Structure:**
```
packages/core/src/checkout/
|- actions/
|   +- processCheckout.ts
+- index.ts
```

**When to create:** Operation spans 3+ features, workflow has its own rules, need single entry point.

---

## 3. Computation Features

Features that **calculate or transform** data without persistence.

**Examples:** `pricing`, `tax-calculation`, `eligibility`, `shipping-calculator`

**Structure:**
```
packages/core/src/pricing/
|- PriceCalculation.ts   # Value object (result)
|- actions/
|   +- calculatePrice.ts
+- index.ts
```

**When to create:** Complex logic warrants isolation, multiple features need same calculation.

---

## Decision Guide

```
1. Does this feature OWN data that needs to be persisted?
   YES -> Resource Feature (entity + repository)
   NO  -> Continue

2. Does this feature COORDINATE multiple other features?
   YES -> Orchestration Feature (function dependencies only)
   NO  -> Continue

3. Does this feature CALCULATE or TRANSFORM data?
   YES -> Computation Feature (pure functions)
   NO  -> Probably not a separate feature
```

---

## Quick Reference

| Requirement | Feature Type | Reasoning |
|-------------|--------------|-----------|
| Users create and manage orders | Resource | Persisted, has lifecycle |
| Process checkout (validate, charge, create order, reserve) | Orchestration | Coordinates 4 features |
| Calculate shipping cost | Computation | Pure calculation |
| Send order confirmation emails | Not a feature | Side effect, use shared `Mailer` |

---

## Orchestration Feature Pattern

```typescript
// packages/core/src/checkout/actions/processCheckout.ts

// Define data shapes HERE (not imported from other features)
export interface CustomerInfo { id: string; email: string; isVerified: boolean; }
export interface OrderResult { id: string; total: number; }
export interface PaymentResult { success: boolean; transactionId?: string; error?: string; }

// Dependencies are functions, not repositories
export interface ProcessCheckoutDeps {
  getCustomer: (customerId: string) => Promise<CustomerInfo | null>;
  createOrder: (customerId: string, items: CartItem[]) => Promise<OrderResult>;
  processPayment: (customerId: string, amount: number) => Promise<PaymentResult>;
  reserveInventory: (orderId: string, items: CartItem[]) => Promise<void>;
  mailer: Mailer;
}

export async function processCheckout(
  deps: ProcessCheckoutDeps,
  ctx: AuthContext,
  input: { customerId: string; items: CartItem[] }
): Promise<{ orderId: string; transactionId: string }> {
  const customer = await deps.getCustomer(input.customerId);
  if (!customer) throw new NotFoundError('Customer not found');

  const order = await deps.createOrder(customer.id, input.items);
  const payment = await deps.processPayment(customer.id, order.total);
  if (!payment.success) throw new BusinessError(`Payment failed: ${payment.error}`);

  await deps.reserveInventory(order.id, input.items);
  await deps.mailer.send(customer.email, 'Order Confirmed', `Order #${order.id}`);

  return { orderId: order.id, transactionId: payment.transactionId! };
}
```

See [Cross-Feature Communication](./13-cross-feature-communication.md) for wiring details.

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Repository for orchestration features | Use function dependencies |
| Resource features too large (15+ actions) | Split into separate features |
| Orchestration logic in resource features | Extract to orchestration feature |
| Single utility function as feature | Keep in `shared/` |
| Importing repositories from other features | Use function dependencies |

---

## Signs You Need to Split

Resource features can grow too large. Split when:
- 15+ actions
- Actions deal with distinct sub-entities (e.g., `Payment` inside `orders`)
- Some actions could be reused by other features

```
# Before: payments buried in orders
packages/core/src/orders/actions/
|- createOrder.ts
|- capturePayment.ts      # Payment-related
+- refundPayment.ts       # Payment-related

# After: payments promoted
packages/core/src/orders/actions/
+- createOrder.ts

packages/core/src/payments/    # New feature
|- Payment.ts
|- PaymentRepository.ts
+- actions/
    |- capturePayment.ts
    +- refundPayment.ts
```

---

## Implementation Checklists

### Resource Feature

| Step | Location | File |
|------|----------|------|
| 1. Create Entity | `core/{feature}/` | `{Name}.ts` |
| 2. Create Repository Contract | `core/{feature}/` | `{Name}Repository.ts` |
| 3. Create Policies | `core/{feature}/` | `{Name}Policies.ts` |
| 4. Create Actions | `core/{feature}/actions/` | `{verbNoun}.ts` |
| 5. Create Index | `core/{feature}/` | `index.ts` |
| 6. Create Repository Impl | `infra/{feature}/` | `{Name}Repository{Provider}.ts` |
| 7. Create Validators | `packages/shared/src/validation/` | `{feature}.ts` |
| 8. Create Handlers | `apps/client/pages/api/{feature}/` | `index.ts`, `[id].ts` |
| 9. Wire Dependencies | Handler or middleware | - |

### Orchestration Feature

| Step | Location | File |
|------|----------|------|
| 1. Define Data Interfaces | In action file | (embedded) |
| 2. Define Function Dependencies | In action file | (embedded) |
| 3. Create Actions | `core/{feature}/actions/` | `{verbNoun}.ts` |
| 4. Create Index | `core/{feature}/` | `index.ts` |
| 5. Wire Function Dependencies | Handler or middleware | - |

### Computation Feature

| Step | Location | File |
|------|----------|------|
| 1. Create Value Objects (optional) | `core/{feature}/` | `{Name}.ts` |
| 2. Create Actions | `core/{feature}/actions/` | `{verbNoun}.ts` |
| 3. Create Index | `core/{feature}/` | `index.ts` |

---

## Next Steps

- [Cross-Feature Communication](./13-cross-feature-communication.md) - Function dependencies
- [Actions](./05-actions.md) - Action patterns
- [Domain Objects](./03-domain-objects.md) - Entity design
