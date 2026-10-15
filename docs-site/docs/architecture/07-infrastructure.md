---
title: Infrastructure
description: Infrastructure contains implementations of contracts — the actual external systems like databases, email, and payment gateways.
sidebar_position: 8
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Infrastructure

[← Back to README](./README.md)

---

## What Is Infrastructure?

Infrastructure contains implementations of contracts. These are the actual external systems:
- Databases (MongoDB, PostgreSQL, etc.)
- Email providers (SendGrid, Mailgun, etc.)
- Payment gateways (Stripe, PayPal, etc.)
- File storage (S3, local filesystem, etc.)
- Message queues (RabbitMQ, SQS, etc.)

---

## Folder Structure

Infrastructure uses a **hybrid approach**: feature-specific implementations organized by feature, with shared utilities in a `shared/` folder.

```
packages/
└── infra/
    └── src/
        ├── shared/                          # Cross-cutting infrastructure
        │   ├── mongodb/
        │   │   ├── connection.ts            # Connection management
        │   │   └── BaseMongoRepository.ts
        │   ├── email/
        │   │   └── SendGridMailer.ts        # Implements core/shared/Mailer.ts
        │   ├── payments/
        │   │   └── StripePaymentGateway.ts  # Implements core/shared/PaymentGateway.ts
        │   └── logging/
        │       └── PinoLogger.ts            # Implements core/shared/Logger.ts
        │
        ├── orders/                          # Feature-specific infra
        │   ├── OrderRepositoryMongo.ts      # Implements core/orders/OrderRepository.ts
        │   └── memory/
        │       └── InMemoryOrderRepository.ts
        │
        └── users/                           # Feature-specific infra
            ├── UserRepositoryMongo.ts       # Implements core/users/UserRepository.ts
            └── memory/
                └── InMemoryUserRepository.ts
```

---

## Where Does It Go? Follow the Contract

The **single rule**: Implementation location mirrors contract location.

```
Contract Location               →  Implementation Location
─────────────────────────────────────────────────────────────
core/shared/Mailer.ts           →  infra/shared/email/SendGridMailer.ts
core/shared/Logger.ts           →  infra/shared/logging/PinoLogger.ts
core/orders/OrderRepository.ts  →  infra/orders/OrderRepositoryMongo.ts
core/users/UserRepository.ts    →  infra/users/UserRepositoryMongo.ts
```

### Decision Guide

| Question | Answer | Location |
|----------|--------|----------|
| Is the contract in `core/shared/`? | Yes | `infra/shared/{technology}/` |
| Is the contract in `core/{feature}/`? | Yes | `infra/{feature}/` |
| Is it infrastructure plumbing (connection pools, base classes)? | Yes | `infra/shared/{technology}/` |
| Is it a test fake for a feature? | Yes | `infra/{feature}/memory/` |

### Why This Works

1. **Zero decisions** - Contract location already decided where implementation goes
2. **Mirrors core** - `@infra/orders` ↔ `@core/orders`
3. **Clear ownership** - Feature team owns everything in `infra/{feature}/`
4. **Easy cleanup** - Delete a feature? Delete `core/{feature}/` and `infra/{feature}/`

---

## What Goes in `shared/`

Only these belong in `infra/shared/`:

| Category | Examples | Why Shared |
|----------|----------|------------|
| **Shared contract implementations** | SendGridMailer, PinoLogger, StripePaymentGateway | Contract is in `core/shared/` |
| **Connection management** | MongoDB connection, Redis client | Multiple features use same connection |
| **Base classes** | BaseMongoRepository | DRY for common patterns |
| **Infrastructure utilities** | Retry helpers, circuit breakers | Cross-cutting concerns |

### What Does NOT Go in `shared/`

| Don't Put Here | Put Here Instead | Why |
|----------------|------------------|-----|
| OrderRepositoryMongo | `infra/orders/` | Contract is in `core/orders/` |
| Feature-specific adapters | `infra/{feature}/` | Only one feature uses it |
| Test fakes for features | `infra/{feature}/memory/` | Co-locate with feature |

---

## Example: Feature Repository (MongoDB + Mongoose)

```typescript
// packages/infra/src/orders/OrderRepositoryMongo.ts
import { Model } from 'mongoose';
import { Order, OrderItem, OrderStatus } from '@packages/core/orders/Order';
import { OrderRepository } from '@packages/core/orders/OrderRepository';
import { OrderModel, IOrder } from './models/OrderModel';

export class OrderRepositoryMongo implements OrderRepository {
  constructor(private model: Model<IOrder> = OrderModel) {}

  async save(order: Order): Promise<void> {
    await this.model.findOneAndUpdate(
      { _id: order.id },
      {
        customerId: order.customerId,
        items: order.items,
        status: order.status,
        cancelReason: order.cancelReason,
      },
      { upsert: true, new: true }
    );
  }

  async findById(id: string): Promise<Order | null> {
    const doc = await this.model.findById(id).lean();
    if (!doc) return null;
    return this.toDomain(doc);
  }

  async findByCustomer(customerId: string): Promise<Order[]> {
    const docs = await this.model
      .find({ customerId })
      .sort({ createdAt: -1 })
      .lean();
    return docs.map(doc => this.toDomain(doc));
  }

  private toDomain(doc: IOrder): Order {
    return new Order(
      doc._id.toString(),
      doc.customerId,
      doc.items as OrderItem[],
      doc.status as OrderStatus,
      doc.cancelReason
    );
  }
}
```

### Mongoose Model Definition

```typescript
// packages/infra/src/orders/models/OrderModel.ts
import mongoose, { Schema, Document } from 'mongoose';

export interface IOrder extends Document {
  _id: string;
  customerId: string;
  items: Array<{
    productId: string;
    quantity: number;
    price: number;
  }>;
  status: string;
  cancelReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema = new Schema<IOrder>(
  {
    _id: { type: String, required: true },
    customerId: { type: String, required: true, index: true },
    items: [{
      productId: { type: String, required: true },
      quantity: { type: Number, required: true },
      price: { type: Number, required: true },
    }],
    status: { type: String, required: true, index: true },
    cancelReason: { type: String },
  },
  { timestamps: true }
);

export const OrderModel = mongoose.model<IOrder>('Order', OrderSchema);
```

> **Note**: For applications with complex read requirements, you may extend your repository with optimized DTO queries. See [CQRS and Read Models](./11-cqrs-and-read-models.md) for details.

---

## Example: Shared Email Provider

```typescript
// packages/infra/src/shared/email/SendGridMailer.ts
// Note: In shared/ because contract is in core/shared/Mailer.ts
import sgMail from '@sendgrid/mail';
import { Mailer } from '@packages/core/shared/Mailer';

export class SendGridMailer implements Mailer {
  constructor(apiKey: string, private fromEmail: string) {
    sgMail.setApiKey(apiKey);
  }

  async send(to: string, subject: string, body: string): Promise<void> {
    await sgMail.send({
      to,
      from: this.fromEmail,
      subject,
      text: body
    });
  }
}
```

---

## Example: Shared Payment Gateway

```typescript
// packages/infra/src/shared/payments/StripePaymentGateway.ts
// Note: In shared/ because contract is in core/shared/PaymentGateway.ts
import Stripe from 'stripe';
import { PaymentGateway, PaymentResult } from '@packages/core/shared/PaymentGateway';

export class StripePaymentGateway implements PaymentGateway {
  private stripe: Stripe;

  constructor(apiKey: string) {
    this.stripe = new Stripe(apiKey);
  }

  async charge(customerId: string, amount: number): Promise<PaymentResult> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: 'usd',
        customer: customerId,
        confirm: true
      });

      return {
        success: paymentIntent.status === 'succeeded',
        transactionId: paymentIntent.id
      };
    } catch (error) {
      return {
        success: false,
        transactionId: '',
        error: error.message
      };
    }
  }

  async refund(transactionId: string, amount: number): Promise<PaymentResult> {
    try {
      const refund = await this.stripe.refunds.create({
        payment_intent: transactionId,
        amount: Math.round(amount * 100)
      });

      return {
        success: refund.status === 'succeeded',
        transactionId: refund.id
      };
    } catch (error) {
      return {
        success: false,
        transactionId: '',
        error: error.message
      };
    }
  }
}
```

---

## Example: Shared Logger

```typescript
// packages/infra/src/shared/logging/PinoLogger.ts
// Note: In shared/ because contract is in core/shared/Logger.ts
import pino from 'pino';
import { Logger, LogData } from '@packages/core/shared/Logger';

export class PinoLogger implements Logger {
  private logger: pino.Logger;

  constructor(options?: pino.LoggerOptions) {
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      ...options,
    });
  }

  info(data: LogData): void {
    this.logger.info(data);
  }

  warn(data: LogData): void {
    this.logger.warn(data);
  }

  error(data: LogData): void {
    this.logger.error(data);
  }
}
```

---

## Key Responsibilities

### 1. Implement the Contract

```typescript
// Contract says:
interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
}

// Implementation fulfills it:
class OrderRepositoryMongo implements OrderRepository {
  async save(order: Order): Promise<void> { /* ... */ }
  async findById(id: string): Promise<Order | null> { /* ... */ }
}
```

### 2. Handle External System Details

- Connection management
- Query building
- Error handling
- Retries
- Timeouts

### 3. Translate Between Formats

```typescript
// Database document → Domain object
private toDomain(doc: IOrder): Order {
  return new Order(
    doc._id.toString(),
    doc.customerId,
    doc.items,
    doc.status,
    doc.cancelReason
  );
}

// Domain object → Database document
async save(order: Order): Promise<void> {
  await this.model.findOneAndUpdate(
    { _id: order.id },
    { customerId: order.customerId, items: order.items, status: order.status },
    { upsert: true }
  );
}
```

---

## Test Fakes (In-Memory Implementations)

Test fakes live in the feature's `memory/` subfolder, co-located with the real implementation:

```typescript
// packages/infra/src/orders/memory/InMemoryOrderRepository.ts
// Note: In orders/memory/ because it's a fake for orders/OrderRepositoryMongo.ts
import { Order } from '@packages/core/orders/Order';
import { OrderRepository } from '@packages/core/orders/OrderRepository';

export class InMemoryOrderRepository implements OrderRepository {
  private orders: Map<string, Order> = new Map();

  async save(order: Order): Promise<void> {
    this.orders.set(order.id, order);
  }

  async findById(id: string): Promise<Order | null> {
    return this.orders.get(id) || null;
  }

  async findByCustomer(customerId: string): Promise<Order[]> {
    return Array.from(this.orders.values())
      .filter(o => o.customerId === customerId);
  }

  // Test helpers
  clear(): void {
    this.orders.clear();
  }

  getAll(): Order[] {
    return Array.from(this.orders.values());
  }
}
```

### Why Co-locate Fakes?

| Benefit | Description |
|---------|-------------|
| **Discoverability** | Find fake right next to real implementation |
| **Ownership** | Feature team maintains both real and fake |
| **Consistency** | Fake evolves with the contract |
| **Deletion** | Remove feature, fakes go too |

---

## Import Rules

Infrastructure can import from:
- ✅ `@packages/core` (to implement contracts and use domain objects)
- ✅ `@packages/infra/shared` (for base classes and shared utilities)
- ✅ External libraries (mongoose, @sendgrid/mail, etc.)
- ❌ `apps/` (infrastructure shouldn't know about specific apps or HTTP)
- ❌ Other feature infra (e.g., `@packages/infra/orders` cannot import from `@packages/infra/users`)

---

## Logging

### Philosophy

| Principle | Description |
|-----------|-------------|
| **Log at boundaries** | Entry points (API, workers) log, not actions |
| **Minimal logging** | Errors and significant events only |
| **Structured format** | JSON objects, not string messages |
| **Logger as dependency** | Passed in deps, not imported globally |

### Logger Contract

```typescript
// packages/core/src/shared/Logger.ts
export interface LogData {
  requestId: string;
  event: string;
  [key: string]: unknown;
}

export interface Logger {
  info(data: LogData): void;
  warn(data: LogData): void;
  error(data: LogData): void;
}
```

### Implementation Example

```typescript
// packages/infra/src/shared/logging/PinoLogger.ts
import pino from 'pino';
import { Logger, LogData } from '@packages/core/shared/Logger';

export class PinoLogger implements Logger {
  private logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  info(data: LogData): void { this.logger.info(data); }
  warn(data: LogData): void { this.logger.warn(data); }
  error(data: LogData): void { this.logger.error(data); }
}
```

### What NEVER to Log

| Category | Examples |
|----------|----------|
| **Secrets** | API keys, tokens, passwords |
| **PII** | Email, phone, name, address |
| **Financial** | Credit card numbers, bank accounts |

Use identifiers (`customerId`) instead of the actual data.

---

## Repository Pattern Enforcement

All data access in the infrastructure layer MUST go through Repository classes that implement core contracts. Standalone factory functions that return closures performing database queries are prohibited.

**Correct:**
```typescript
export class AgentRepositoryMongo implements AgentRepository {
  constructor(private readonly model: Model<any>) {}
  async findByIds(ids: string[]): Promise<AgentReadData[]> { /* ... */ }
}
```

**Incorrect:**
```typescript
export function createGetAgentsByIds(model: Model<any>) {
  return async (ids: string[]) => { /* direct DB query */ };
}
```

Repository classes are easier to test, follow the contract defined in core, and keep infrastructure concerns properly encapsulated.

---

## Next Steps

- [CQRS and Read Models](./11-cqrs-and-read-models.md) - Learn about the Repository pattern
- [Entry Points](./06-entry-points.md) - Learn about HTTP API, CLI, and Workers
- [Testing](./15-testing.md) - Learn about testing with fakes
