---
title: Domain Objects
description: Domain objects represent your business entities — their data, computed properties, state checks, and validated state transitions.
sidebar_position: 4
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Domain Objects

[← Back to README](./README.md)

---

## What Are Domain Objects?

Domain objects represent your business entities. They contain:
- **Data** - The state of the entity
- **Computed Properties** - Derived values
- **State Checks** - Methods to query state
- **State Transitions** - Methods that change state with validation

They throw `InvariantError` when state transitions are invalid.

---

## Example: Order Entity

```typescript
// packages/core/src/orders/Order.ts
import { InvariantError } from '../shared/errors';

export type OrderStatus = 'draft' | 'submitted' | 'paid' | 'shipped' | 'cancelled';

export interface OrderItem {
  productId: string;
  quantity: number;
  price: number;
}

export class Order {
  constructor(
    public readonly id: string,
    public readonly customerId: string,
    public items: OrderItem[],
    public status: OrderStatus = 'draft',
    public cancelReason?: string
  ) {}

  // Computed properties
  get total(): number {
    return this.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  // State checks
  canCancel(): boolean {
    return ['draft', 'submitted', 'paid'].includes(this.status);
  }

  canModify(): boolean {
    return this.status === 'draft';
  }

  // State transitions (with invariant validation)
  submit(): void {
    if (this.items.length === 0) {
      throw new InvariantError('Cannot submit empty order');
    }
    if (this.status !== 'draft') {
      throw new InvariantError('Order already submitted');
    }
    this.status = 'submitted';
  }

  cancel(reason: string): void {
    if (!this.canCancel()) {
      throw new InvariantError(`Cannot cancel order in ${this.status} status`);
    }
    this.status = 'cancelled';
    this.cancelReason = reason;
  }

  addItem(item: OrderItem): void {
    if (!this.canModify()) {
      throw new InvariantError('Cannot modify submitted order');
    }
    if (item.quantity <= 0) {
      throw new InvariantError('Quantity must be positive');
    }
    this.items.push(item);
  }
}
```

---

## Anatomy of a Domain Object

### 1. Data (Properties)

```typescript
export class Order {
  constructor(
    public readonly id: string,           // Immutable identity
    public readonly customerId: string,   // Immutable reference
    public items: OrderItem[],            // Mutable state
    public status: OrderStatus = 'draft', // Mutable state with default
    public cancelReason?: string          // Optional mutable state
  ) {}
}
```

### 2. Computed Properties

Derived values that are calculated from state:

```typescript
get total(): number {
  return this.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

get itemCount(): number {
  return this.items.reduce((sum, item) => sum + item.quantity, 0);
}

get isEmpty(): boolean {
  return this.items.length === 0;
}
```

### 3. State Checks

Methods that query whether an operation is allowed:

```typescript
canCancel(): boolean {
  return ['draft', 'submitted', 'paid'].includes(this.status);
}

canModify(): boolean {
  return this.status === 'draft';
}

canShip(): boolean {
  return this.status === 'paid';
}

isComplete(): boolean {
  return ['shipped', 'cancelled'].includes(this.status);
}
```

### 4. State Transitions

Methods that change state with validation:

```typescript
submit(): void {
  // Validate invariants
  if (this.items.length === 0) {
    throw new InvariantError('Cannot submit empty order');
  }
  if (this.status !== 'draft') {
    throw new InvariantError('Order already submitted');
  }
  // Transition state
  this.status = 'submitted';
}
```

---

## The InvariantError

Domain objects throw `InvariantError` to protect themselves from invalid states. For the error class definition, see [Error Handling](./16-error-handling.md).

**Key principle**: The entity protects itself. No one can put it in an invalid state.

---

## What Domain Objects Should NOT Do

| Don't | Why |
|-------|-----|
| Access database | That's the action's job |
| Send emails | That's a side effect |
| Call external APIs | That's infrastructure |
| Know about HTTP | That's the API layer |
| Import from `infra/` or `api/` | Breaks the dependency rule |

---

## Example: User Entity

```typescript
// packages/core/src/users/User.ts
import { InvariantError } from '../shared/errors';

export type UserStatus = 'pending' | 'active' | 'suspended';

export class User {
  constructor(
    public readonly id: string,
    public email: string,
    private passwordHash: string,
    public status: UserStatus = 'pending',
    public readonly createdAt: Date = new Date()
  ) {}

  // Computed
  get isActive(): boolean {
    return this.status === 'active';
  }

  // State checks
  canLogin(): boolean {
    return this.status === 'active';
  }

  // State transitions
  activate(): void {
    if (this.status !== 'pending') {
      throw new InvariantError('User is not pending activation');
    }
    this.status = 'active';
  }

  suspend(): void {
    if (this.status === 'suspended') {
      throw new InvariantError('User is already suspended');
    }
    this.status = 'suspended';
  }

  changeEmail(newEmail: string): void {
    if (!this.isActive) {
      throw new InvariantError('Cannot change email for inactive user');
    }
    if (!newEmail.includes('@')) {
      throw new InvariantError('Invalid email format');
    }
    this.email = newEmail;
  }
}
```

---

## Code Templates

<!-- TEMPLATES: Copy and replace placeholders marked with {PLACEHOLDER} -->

### Entity Template

```typescript
// packages/core/src/{feature}/{EntityName}.ts
import { InvariantError } from '../shared/errors';

// Status type - define all possible states
export type {EntityName}Status = '{status1}' | '{status2}' | '{status3}';

// Item/child type (if entity has a collection)
export interface {EntityName}Item {
  {itemProperty1}: string;
  {itemProperty2}: number;
}

export class {EntityName} {
  constructor(
    public readonly id: string,
    public readonly {ownerIdField}: string,  // e.g., customerId, userId
    private _{items}: {EntityName}Item[],
    private _status: {EntityName}Status = '{defaultStatus}',
    private _{optionalField}?: string
  ) {}

  // ============================================
  // GETTERS (expose private state as read-only)
  // ============================================

  get status(): {EntityName}Status {
    return this._status;
  }

  get {items}(): readonly {EntityName}Item[] {
    return this._{items};
  }

  // ============================================
  // COMPUTED PROPERTIES
  // ============================================

  get total(): number {
    return this._{items}.reduce(
      (sum, item) => sum + item.{itemProperty2},
      0
    );
  }

  get isEmpty(): boolean {
    return this._{items}.length === 0;
  }

  // ============================================
  // STATE CHECKS (return boolean)
  // ============================================

  can{Action1}(): boolean {
    return ['{allowedStatus1}', '{allowedStatus2}'].includes(this._status);
  }

  can{Action2}(): boolean {
    return this._status === '{requiredStatus}';
  }

  isComplete(): boolean {
    return ['{finalStatus1}', '{finalStatus2}'].includes(this._status);
  }

  // ============================================
  // STATE TRANSITIONS (mutate state, throw InvariantError)
  // ============================================

  {transitionMethod1}(): void {
    if (this.isEmpty) {
      throw new InvariantError('Cannot {transitionMethod1} empty {entityName}');
    }
    if (this._status !== '{requiredStatus}') {
      throw new InvariantError('{EntityName} already {pastTenseAction}');
    }
    this._status = '{newStatus}';
  }

  {transitionMethod2}(reason: string): void {
    if (!this.can{Action1}()) {
      throw new InvariantError(
        `Cannot {transitionMethod2} {entityName} in ${this._status} status`
      );
    }
    this._status = '{newStatus2}';
    this._{optionalField} = reason;
  }

  add{Item}(item: {EntityName}Item): void {
    if (!this.can{Action2}()) {
      throw new InvariantError('Cannot modify {entityName} in current status');
    }
    if (item.{itemProperty2} <= 0) {
      throw new InvariantError('{ItemProperty2} must be positive');
    }
    this._{items}.push(item);
  }
}
```

### Repository Contract Template

```typescript
// packages/core/src/{feature}/{EntityName}Repository.ts
import { {EntityName} } from './{EntityName}';

export interface {EntityName}Repository {
  // Write operations
  save(entity: {EntityName}): Promise<void>;
  delete(id: string): Promise<void>;

  // Read operations - return null for not found, don't throw
  findById(id: string): Promise<{EntityName} | null>;
  findBy{OwnerField}({ownerField}: string): Promise<{EntityName}[]>;

  // Query operations (if needed)
  findAll(options?: { limit?: number; offset?: number }): Promise<{EntityName}[]>;
  count(): Promise<number>;
}
```

### Policies Template

```typescript
// packages/core/src/{feature}/{EntityName}Policies.ts
import { AuthContext } from '../shared/authorization';
import { {EntityName} } from './{EntityName}';

export const {EntityName}Policies = {
  canCreate(ctx: AuthContext): boolean {
    return ctx.roles.includes('{requiredRole}') || ctx.isAdmin;
  },

  canRead(ctx: AuthContext, entity: {EntityName}): boolean {
    return entity.{ownerIdField} === ctx.userId || ctx.isAdmin;
  },

  canUpdate(ctx: AuthContext, entity: {EntityName}): boolean {
    return entity.{ownerIdField} === ctx.userId || ctx.isAdmin;
  },

  canDelete(ctx: AuthContext, entity: {EntityName}): boolean {
    return ctx.isAdmin;
  },
};
```

### Feature Index Template

```typescript
// packages/core/src/{feature}/index.ts

// Entity
export { {EntityName}, {EntityName}Status, {EntityName}Item } from './{EntityName}';

// Contract
export { {EntityName}Repository } from './{EntityName}Repository';

// Policies
export { {EntityName}Policies } from './{EntityName}Policies';

// Actions
export {
  create{EntityName},
  Create{EntityName}Deps,
  Create{EntityName}Input,
} from './actions/create{EntityName}';

export {
  {action2Name},
  {Action2Name}Deps,
  {Action2Name}Input,
} from './actions/{action2Name}';
```

---

## Where to Put Logic

<!-- DECISION-GUIDE: Entity vs Action -->

> **Entity protects itself. Action orchestrates the world.**

| Put in Entity | Put in Action |
|---------------|---------------|
| State transitions (`submit()`, `cancel()`) | Authorization (policy checks) |
| State validation (`canCancel()`) | Database operations (load, save) |
| Computed properties (`get total()`) | External API calls |
| Invariants (throw `InvariantError`) | Side effects (email, analytics) |
| Core calculations | Business validation requiring DB |

**Rule of thumb**: If it needs `await`, it goes in Action.

### Decision Flowchart

```
Does it require external systems (DB, API, email)?
├── YES → Put in Action
└── NO → Does it protect entity state?
         ├── YES → Put in Entity
         └── NO → Is it a computed value from entity state?
                  ├── YES → Put in Entity (as getter)
                  └── NO → Put in Action
```

### When in Doubt

Start with logic in actions. Move to entity when:
- Same validation repeated in multiple actions
- Bugs from inconsistent state changes
- Entity can be put in invalid states

---

## Next Steps

- [Contracts](./04-contracts.md) - Learn about interfaces
- [Actions](./05-actions.md) - Learn about business operations
- [Authorization](./09-authorization.md) - Learn about policies and permissions
