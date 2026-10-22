---
title: "Tutorial: Building a Products Feature from Scratch"
description: A complete walkthrough of creating a Products feature for an e-commerce system — entity, repository, policies, actions, API, and tests.
sidebar_position: 19
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Tutorial: Building a Products Feature from Scratch

[← Back to README](./README.md)

---

## What You'll Build

This tutorial walks through creating a complete **Products** feature for an e-commerce system. By the end, you'll have:

- A `Product` entity with business rules
- A repository contract and implementation
- Authorization policies
- Actions for creating, updating, and discontinuing products
- API endpoints with validation
- Tests using fakes

---

## Prerequisites

Before starting, read:
- [00-quick-reference.md](./00-quick-reference.md) - File paths and signatures
- [01-core-concepts.md](./01-core-concepts.md) - The 3-concept model

---

## Final Result: What We're Building

```
packages/
├── core/
│   └── src/
│       └── products/
│           ├── Product.ts              # Entity
│           ├── ProductRepository.ts    # Contract
│           ├── ProductPolicies.ts      # Authorization
│           ├── actions/
│           │   ├── createProduct.ts
│           │   ├── updateProduct.ts
│           │   └── discontinueProduct.ts
│           └── index.ts                # Exports
│
└── infra/
    └── src/
        └── products/
            ├── ProductRepositoryMongo.ts
            └── memory/
                └── InMemoryProductRepository.ts

apps/
└── client/
    └── pages/
        └── api/
            ├── validators/
            │   └── productValidators.ts
            └── products/
                ├── index.ts            # POST /api/products, GET /api/products
                └── [id].ts             # GET, PATCH /api/products/:id
```

---

## Step 1: Create the Entity

The entity is the heart of your feature. It contains the data, business rules, and state transitions.

**File**: `packages/core/src/products/Product.ts`

```typescript
// packages/core/src/products/Product.ts
import { InvariantError } from '../shared/errors';

// All possible product statuses
export type ProductStatus = 'draft' | 'active' | 'discontinued';

export class Product {
  constructor(
    public readonly id: string,
    public readonly createdBy: string,        // User who created this product
    private _name: string,
    private _description: string,
    private _price: number,                   // In cents to avoid floating point issues
    private _stock: number,
    private _category: string,
    private _status: ProductStatus = 'draft',
    public readonly createdAt: Date = new Date()
  ) {
    // Validate on construction
    if (_price < 0) {
      throw new InvariantError('Price cannot be negative');
    }
    if (_stock < 0) {
      throw new InvariantError('Stock cannot be negative');
    }
  }

  // ============================================
  // GETTERS (expose private state as read-only)
  // ============================================

  get name(): string {
    return this._name;
  }

  get description(): string {
    return this._description;
  }

  get price(): number {
    return this._price;
  }

  get stock(): number {
    return this._stock;
  }

  get category(): string {
    return this._category;
  }

  get status(): ProductStatus {
    return this._status;
  }

  // ============================================
  // COMPUTED PROPERTIES
  // ============================================

  get priceInDollars(): number {
    return this._price / 100;
  }

  get isInStock(): boolean {
    return this._stock > 0;
  }

  get isAvailableForSale(): boolean {
    return this._status === 'active' && this.isInStock;
  }

  // ============================================
  // STATE CHECKS (return boolean, let caller decide)
  // ============================================

  canActivate(): boolean {
    // Can only activate draft products with valid data
    return this._status === 'draft' && this._price > 0 && this._name.length > 0;
  }

  canUpdate(): boolean {
    // Can update draft or active products, not discontinued
    return this._status !== 'discontinued';
  }

  canDiscontinue(): boolean {
    // Can discontinue active products
    return this._status === 'active';
  }

  // ============================================
  // STATE TRANSITIONS (mutate state, throw InvariantError)
  // ============================================

  activate(): void {
    if (!this.canActivate()) {
      throw new InvariantError(
        `Cannot activate product in ${this._status} status or with invalid data`
      );
    }
    this._status = 'active';
  }

  discontinue(): void {
    if (!this.canDiscontinue()) {
      throw new InvariantError(
        `Cannot discontinue product in ${this._status} status`
      );
    }
    this._status = 'discontinued';
  }

  updateDetails(data: {
    name?: string;
    description?: string;
    price?: number;
    category?: string;
  }): void {
    if (!this.canUpdate()) {
      throw new InvariantError('Cannot update discontinued product');
    }

    if (data.name !== undefined) {
      if (data.name.trim().length === 0) {
        throw new InvariantError('Product name cannot be empty');
      }
      this._name = data.name.trim();
    }

    if (data.description !== undefined) {
      this._description = data.description;
    }

    if (data.price !== undefined) {
      if (data.price < 0) {
        throw new InvariantError('Price cannot be negative');
      }
      this._price = data.price;
    }

    if (data.category !== undefined) {
      this._category = data.category;
    }
  }

  adjustStock(quantity: number): void {
    if (!this.canUpdate()) {
      throw new InvariantError('Cannot adjust stock for discontinued product');
    }

    const newStock = this._stock + quantity;
    if (newStock < 0) {
      throw new InvariantError(
        `Insufficient stock. Current: ${this._stock}, Requested: ${quantity}`
      );
    }
    this._stock = newStock;
  }
}
```

### Key Points

| Concept | Example in Code |
|---------|-----------------|
| **Private state with getters** | `private _price` with `get price()` |
| **Computed properties** | `get priceInDollars()`, `get isAvailableForSale()` |
| **State checks** | `canActivate()`, `canUpdate()` return boolean |
| **State transitions** | `activate()`, `discontinue()` throw `InvariantError` |
| **Validation in constructor** | Price and stock cannot be negative |

---

## Step 2: Create the Repository Contract

The contract defines HOW you interact with storage without specifying the implementation.

**File**: `packages/core/src/products/ProductRepository.ts`

```typescript
// packages/core/src/products/ProductRepository.ts
import { Product } from './Product';

export interface ProductRepository {
  // Write operations
  save(product: Product): Promise<void>;
  delete(id: string): Promise<void>;

  // Read operations - return null for not found, don't throw
  findById(id: string): Promise<Product | null>;
  findByCategory(category: string): Promise<Product[]>;

  // Query operations
  findAll(options?: {
    limit?: number;
    offset?: number;
    status?: string;
  }): Promise<Product[]>;

  findActive(): Promise<Product[]>;
}
```

### Why Return `null` Instead of Throwing?

The repository doesn't know if "not found" is an error. The **action** decides:

```typescript
// In action - decides what "not found" means
const product = await deps.repository.findById(productId);
if (!product) {
  throw new NotFoundError('Product not found');  // Action throws, not repo
}
```

---

## Step 3: Create Authorization Policies

Policies define WHO can do WHAT with products.

**File**: `packages/core/src/products/ProductPolicies.ts`

```typescript
// packages/core/src/products/ProductPolicies.ts
import { AuthContext } from '../shared/authorization/AuthContext';
import { Product } from './Product';

export const ProductPolicies = {
  /**
   * Can the user create new products?
   * - Admins can always create
   * - Users with 'seller' role can create
   */
  canCreate(ctx: AuthContext): boolean {
    return ctx.isAdmin || ctx.roles.includes('seller');
  },

  /**
   * Can the user view this product?
   * - Anyone can view active products
   * - Only creator or admin can view draft/discontinued
   */
  canView(ctx: AuthContext, product: Product): boolean {
    if (product.status === 'active') {
      return true;
    }
    return product.createdBy === ctx.userId || ctx.isAdmin;
  },

  /**
   * Can the user update this product?
   * - Only creator or admin can update
   * - Product must not be discontinued
   */
  canUpdate(ctx: AuthContext, product: Product): boolean {
    if (!product.canUpdate()) {
      return false;
    }
    return product.createdBy === ctx.userId || ctx.isAdmin;
  },

  /**
   * Can the user discontinue this product?
   * - Only admin can discontinue
   */
  canDiscontinue(ctx: AuthContext, product: Product): boolean {
    return ctx.isAdmin && product.canDiscontinue();
  },

  /**
   * Can the user delete this product?
   * - Only admin can delete
   * - Only draft products can be deleted
   */
  canDelete(ctx: AuthContext, product: Product): boolean {
    return ctx.isAdmin && product.status === 'draft';
  },
};
```

---

## Step 4: Create Actions

Actions orchestrate the business logic. They follow the pattern:
**Load → Authorize → Validate → Execute → Persist → Side Effects**

### 4a. Create Product Action

**File**: `packages/core/src/products/actions/createProduct.ts`

```typescript
// packages/core/src/products/actions/createProduct.ts
import { AuthContext } from '../../shared/authorization/AuthContext';
import { BusinessError } from '../../shared/errors';
import { Product } from '../Product';
import { ProductRepository } from '../ProductRepository';
import { ProductPolicies } from '../ProductPolicies';

// Dependencies this action needs
export interface CreateProductDeps {
  repository: ProductRepository;
  generateId: () => string;  // Injected for testability
}

// Input shape
export interface CreateProductInput {
  name: string;
  description: string;
  price: number;         // In cents
  stock: number;
  category: string;
}

// The action function
export async function createProduct(
  deps: CreateProductDeps,
  ctx: AuthContext,
  input: CreateProductInput
): Promise<Product> {
  // 1. AUTHORIZE - Check if user can create products
  if (!ProductPolicies.canCreate(ctx)) {
    throw new BusinessError('Not authorized to create products');
  }

  // 2. EXECUTE - Create the entity (constructor validates)
  const product = new Product(
    deps.generateId(),
    ctx.userId,
    input.name,
    input.description,
    input.price,
    input.stock,
    input.category,
    'draft'  // New products start as draft
  );

  // 3. PERSIST - Save to repository
  await deps.repository.save(product);

  // 4. RETURN - Return the created product
  return product;
}
```

### 4b. Update Product Action

**File**: `packages/core/src/products/actions/updateProduct.ts`

```typescript
// packages/core/src/products/actions/updateProduct.ts
import { AuthContext } from '../../shared/authorization/AuthContext';
import { NotFoundError, BusinessError } from '../../shared/errors';
import { Product } from '../Product';
import { ProductRepository } from '../ProductRepository';
import { ProductPolicies } from '../ProductPolicies';

export interface UpdateProductDeps {
  repository: ProductRepository;
}

export interface UpdateProductInput {
  productId: string;
  name?: string;
  description?: string;
  price?: number;
  category?: string;
}

export async function updateProduct(
  deps: UpdateProductDeps,
  ctx: AuthContext,
  input: UpdateProductInput
): Promise<Product> {
  // 1. LOAD - Fetch the product
  const product = await deps.repository.findById(input.productId);
  if (!product) {
    throw new NotFoundError('Product not found');
  }

  // 2. AUTHORIZE - Check if user can update this product
  if (!ProductPolicies.canUpdate(ctx, product)) {
    throw new BusinessError('Not authorized to update this product');
  }

  // 3. EXECUTE - Update via entity method (validates internally)
  product.updateDetails({
    name: input.name,
    description: input.description,
    price: input.price,
    category: input.category,
  });

  // 4. PERSIST - Save changes
  await deps.repository.save(product);

  return product;
}
```

### 4c. Discontinue Product Action

**File**: `packages/core/src/products/actions/discontinueProduct.ts`

```typescript
// packages/core/src/products/actions/discontinueProduct.ts
import { AuthContext } from '../../shared/authorization/AuthContext';
import { NotFoundError, BusinessError } from '../../shared/errors';
import { Product } from '../Product';
import { ProductRepository } from '../ProductRepository';
import { ProductPolicies } from '../ProductPolicies';
import { Mailer } from '../../shared/Mailer';

export interface DiscontinueProductDeps {
  repository: ProductRepository;
  mailer: Mailer;
}

export interface DiscontinueProductInput {
  productId: string;
  reason: string;
  notifyEmail?: string;  // Optional: email to notify
}

export async function discontinueProduct(
  deps: DiscontinueProductDeps,
  ctx: AuthContext,
  input: DiscontinueProductInput
): Promise<Product> {
  // 1. LOAD
  const product = await deps.repository.findById(input.productId);
  if (!product) {
    throw new NotFoundError('Product not found');
  }

  // 2. AUTHORIZE
  if (!ProductPolicies.canDiscontinue(ctx, product)) {
    throw new BusinessError('Not authorized to discontinue this product');
  }

  // 3. VALIDATE (business rules beyond entity invariants)
  if (product.stock > 100) {
    throw new BusinessError(
      'Cannot discontinue product with more than 100 items in stock. ' +
      'Please reduce stock first or use clearance sale.'
    );
  }

  // 4. EXECUTE
  product.discontinue();

  // 5. PERSIST
  await deps.repository.save(product);

  // 6. SIDE EFFECTS (non-critical, don't fail the operation)
  if (input.notifyEmail) {
    await deps.mailer.send(
      input.notifyEmail,
      `Product Discontinued: ${product.name}`,
      `Product "${product.name}" has been discontinued. Reason: ${input.reason}`
    ).catch(err => {
      console.error('Failed to send discontinue notification:', err);
      // Don't throw - email failure shouldn't fail the discontinue operation
    });
  }

  return product;
}
```

---

## Step 5: Create the Feature Index

The index file exports everything other modules need from this feature.

**File**: `packages/core/src/products/index.ts`

```typescript
// packages/core/src/products/index.ts

// Entity
export { Product, ProductStatus } from './Product';

// Contract
export { ProductRepository } from './ProductRepository';

// Policies
export { ProductPolicies } from './ProductPolicies';

// Actions
export {
  createProduct,
  CreateProductDeps,
  CreateProductInput,
} from './actions/createProduct';

export {
  updateProduct,
  UpdateProductDeps,
  UpdateProductInput,
} from './actions/updateProduct';

export {
  discontinueProduct,
  DiscontinueProductDeps,
  DiscontinueProductInput,
} from './actions/discontinueProduct';
```

---

## Step 6: Create Infrastructure Implementations

Now we implement the repository contract with real storage.

### 6a. MongoDB Implementation

**File**: `packages/infra/src/products/ProductRepositoryMongo.ts`

```typescript
// packages/infra/src/products/ProductRepositoryMongo.ts
import { Product, ProductRepository, ProductStatus } from '@packages/core/products';
import mongoose, { Schema, Document } from 'mongoose';

interface ProductDocument extends Document {
  _id: string;
  createdBy: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  category: string;
  status: ProductStatus;
  createdAt: Date;
}

const productSchema = new Schema<ProductDocument>({
  _id: { type: String, required: true },
  createdBy: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  price: { type: Number, required: true },
  stock: { type: Number, required: true },
  category: { type: String, required: true },
  status: { type: String, enum: ['draft', 'active', 'discontinued'], default: 'draft' },
  createdAt: { type: Date, default: Date.now },
});

const ProductModel = mongoose.model<ProductDocument>('Product', productSchema);

export class ProductRepositoryMongo implements ProductRepository {
  async save(product: Product): Promise<void> {
    await ProductModel.findByIdAndUpdate(
      product.id,
      {
        _id: product.id,
        createdBy: product.createdBy,
        name: product.name,
        description: product.description,
        price: product.price,
        stock: product.stock,
        category: product.category,
        status: product.status,
        createdAt: product.createdAt,
      },
      { upsert: true }
    );
  }

  async delete(id: string): Promise<void> {
    await ProductModel.findByIdAndDelete(id);
  }

  async findById(id: string): Promise<Product | null> {
    const doc = await ProductModel.findById(id);
    if (!doc) return null;
    return this.mapDocToProduct(doc);
  }

  async findByCategory(category: string): Promise<Product[]> {
    const docs = await ProductModel.find({ category }).sort({ createdAt: -1 });
    return docs.map(this.mapDocToProduct);
  }

  async findAll(options?: {
    limit?: number;
    offset?: number;
    status?: string;
  }): Promise<Product[]> {
    const { limit = 50, offset = 0, status } = options || {};

    const query: any = {};
    if (status) query.status = status;

    const docs = await ProductModel.find(query)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit);

    return docs.map(this.mapDocToProduct);
  }

  async findActive(): Promise<Product[]> {
    const docs = await ProductModel.find({ status: 'active' }).sort({ createdAt: -1 });
    return docs.map(this.mapDocToProduct);
  }

  private mapDocToProduct(doc: ProductDocument): Product {
    return new Product(
      doc._id,
      doc.createdBy,
      doc.name,
      doc.description,
      doc.price,
      doc.stock,
      doc.category,
      doc.status,
      doc.createdAt
    );
  }
}
```

### 6b. In-Memory Implementation (for Testing)

**File**: `packages/infra/src/products/memory/InMemoryProductRepository.ts`

```typescript
// packages/infra/src/products/memory/InMemoryProductRepository.ts
import { Product, ProductRepository } from '@packages/core/products';

export class InMemoryProductRepository implements ProductRepository {
  private products: Map<string, Product> = new Map();

  async save(product: Product): Promise<void> {
    // Clone to prevent external mutation
    this.products.set(product.id, this.clone(product));
  }

  async delete(id: string): Promise<void> {
    this.products.delete(id);
  }

  async findById(id: string): Promise<Product | null> {
    const product = this.products.get(id);
    return product ? this.clone(product) : null;
  }

  async findByCategory(category: string): Promise<Product[]> {
    return Array.from(this.products.values())
      .filter(p => p.category === category)
      .map(p => this.clone(p));
  }

  async findAll(options?: {
    limit?: number;
    offset?: number;
    status?: string;
  }): Promise<Product[]> {
    const { limit = 50, offset = 0, status } = options || {};

    let products = Array.from(this.products.values());

    if (status) {
      products = products.filter(p => p.status === status);
    }

    return products
      .slice(offset, offset + limit)
      .map(p => this.clone(p));
  }

  async findActive(): Promise<Product[]> {
    return Array.from(this.products.values())
      .filter(p => p.status === 'active')
      .map(p => this.clone(p));
  }

  // Test helpers
  clear(): void {
    this.products.clear();
  }

  count(): number {
    return this.products.size;
  }

  // Clone to prevent test pollution
  private clone(product: Product): Product {
    return new Product(
      product.id,
      product.createdBy,
      product.name,
      product.description,
      product.price,
      product.stock,
      product.category,
      product.status,
      product.createdAt
    );
  }
}
```

---

## Step 7: Create the API Layer

### 7a. Input Validators

**File**: `apps/client/pages/api/validators/productValidators.ts`

```typescript
// apps/client/pages/api/validators/productValidators.ts
import { z } from 'zod';

export const createProductSchema = z.object({
  name: z
    .string()
    .min(1, 'Product name is required')
    .max(200, 'Product name too long'),
  description: z
    .string()
    .max(2000, 'Description too long')
    .default(''),
  price: z
    .number()
    .int('Price must be in cents (whole number)')
    .min(0, 'Price cannot be negative'),
  stock: z
    .number()
    .int('Stock must be a whole number')
    .min(0, 'Stock cannot be negative'),
  category: z
    .string()
    .min(1, 'Category is required'),
});

export const updateProductSchema = z.object({
  name: z
    .string()
    .min(1, 'Product name cannot be empty')
    .max(200, 'Product name too long')
    .optional(),
  description: z
    .string()
    .max(2000, 'Description too long')
    .optional(),
  price: z
    .number()
    .int('Price must be in cents')
    .min(0, 'Price cannot be negative')
    .optional(),
  category: z
    .string()
    .min(1, 'Category cannot be empty')
    .optional(),
});

export const discontinueProductSchema = z.object({
  reason: z
    .string()
    .min(1, 'Reason is required')
    .max(500, 'Reason too long'),
  notifyEmail: z
    .string()
    .email('Invalid email format')
    .optional(),
});

// Type exports for handlers
export type CreateProductRequest = z.infer<typeof createProductSchema>;
export type UpdateProductRequest = z.infer<typeof updateProductSchema>;
export type DiscontinueProductRequest = z.infer<typeof discontinueProductSchema>;
```

### 7b. HTTP Handler (Next.js Pages API)

**File**: `apps/client/pages/api/products/index.ts`

```typescript
// apps/client/pages/api/products/index.ts
import { baseApi } from '@server/middlewares/baseApi';
import { createProduct } from '@packages/core/products';
import { getProductDeps } from '@server/dependencies';
import {
  createProductSchema,
} from '../validators/productValidators';

const handler = baseApi({ auth: true })
  .get(async (req, res) => {
    // List all active products
    const deps = getProductDeps();
    const products = await deps.repository.findActive();

    res.json({
      products: products.map(p => ({
        id: p.id,
        name: p.name,
        price: p.price,
        priceFormatted: `$${p.priceInDollars.toFixed(2)}`,
        category: p.category,
        isInStock: p.isInStock,
      })),
      count: products.length,
    });
  })
  .post(async (req, res) => {
    // Validate input
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    // Call core action
    const deps = getProductDeps();
    const product = await createProduct(deps, req.ctx, parsed.data);

    res.status(201).json({
      id: product.id,
      name: product.name,
      price: product.price,
      status: product.status,
    });
  });

export default handler;
```

---

## Step 8: Wire Dependencies

**File**: `apps/client/server/dependencies.ts` (add to existing)

```typescript
// apps/client/server/dependencies.ts
import { ProductRepositoryMongo } from '@packages/infra/products/ProductRepositoryMongo';
import { randomUUID } from 'crypto';

// ... existing dependencies ...

// Products
const productRepository = new ProductRepositoryMongo();

export function getProductDeps() {
  return {
    repository: productRepository,
    mailer,  // reuse existing mailer
    generateId: () => randomUUID(),
  };
}
```

---

## Step 9: Write Tests

### 9a. Entity Tests

**File**: `packages/core/src/products/Product.test.ts`

```typescript
// packages/core/src/products/Product.test.ts
import { Product } from './Product';
import { InvariantError } from '../shared/errors';

describe('Product', () => {
  function createProduct(overrides: Partial<{
    id: string;
    createdBy: string;
    name: string;
    description: string;
    price: number;
    stock: number;
    category: string;
    status: 'draft' | 'active' | 'discontinued';
  }> = {}): Product {
    return new Product(
      overrides.id ?? 'test-id',
      overrides.createdBy ?? 'user-1',
      overrides.name ?? 'Test Product',
      overrides.description ?? 'A test product',
      overrides.price ?? 1999,
      overrides.stock ?? 10,
      overrides.category ?? 'electronics',
      overrides.status ?? 'draft'
    );
  }

  describe('construction', () => {
    it('creates a product with valid data', () => {
      const product = createProduct();
      expect(product.name).toBe('Test Product');
      expect(product.price).toBe(1999);
      expect(product.status).toBe('draft');
    });

    it('throws InvariantError for negative price', () => {
      expect(() => createProduct({ price: -100 }))
        .toThrow(InvariantError);
    });

    it('throws InvariantError for negative stock', () => {
      expect(() => createProduct({ stock: -1 }))
        .toThrow(InvariantError);
    });
  });

  describe('computed properties', () => {
    it('calculates priceInDollars correctly', () => {
      const product = createProduct({ price: 1999 });
      expect(product.priceInDollars).toBe(19.99);
    });

    it('isAvailableForSale is true for active product with stock', () => {
      const product = createProduct({ status: 'active', stock: 5 });
      expect(product.isAvailableForSale).toBe(true);
    });

    it('isAvailableForSale is false for draft product', () => {
      const product = createProduct({ status: 'draft', stock: 5 });
      expect(product.isAvailableForSale).toBe(false);
    });
  });

  describe('activate', () => {
    it('activates a draft product with valid data', () => {
      const product = createProduct({ status: 'draft' });
      product.activate();
      expect(product.status).toBe('active');
    });

    it('throws InvariantError when activating active product', () => {
      const product = createProduct({ status: 'active' });
      expect(() => product.activate()).toThrow(InvariantError);
    });

    it('throws InvariantError when price is zero', () => {
      const product = createProduct({ price: 0 });
      expect(() => product.activate()).toThrow(InvariantError);
    });
  });

  describe('discontinue', () => {
    it('discontinues an active product', () => {
      const product = createProduct({ status: 'active' });
      product.discontinue();
      expect(product.status).toBe('discontinued');
    });

    it('throws InvariantError when discontinuing draft product', () => {
      const product = createProduct({ status: 'draft' });
      expect(() => product.discontinue()).toThrow(InvariantError);
    });
  });
});
```

### 9b. Action Tests

**File**: `packages/core/src/products/actions/createProduct.test.ts`

```typescript
// packages/core/src/products/actions/createProduct.test.ts
import { createProduct, CreateProductDeps, CreateProductInput } from './createProduct';
import { InMemoryProductRepository } from '@packages/infra/products/memory/InMemoryProductRepository';
import { AuthContext } from '../../shared/authorization/AuthContext';
import { BusinessError } from '../../shared/errors';

describe('createProduct', () => {
  let repository: InMemoryProductRepository;
  let deps: CreateProductDeps;

  const validInput: CreateProductInput = {
    name: 'Test Product',
    description: 'A great product',
    price: 2999,
    stock: 50,
    category: 'electronics',
  };

  function createContext(overrides: Partial<AuthContext> = {}): AuthContext {
    return {
      userId: 'user-1',
      roles: ['seller'],
      isAdmin: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    repository = new InMemoryProductRepository();
    deps = {
      repository,
      generateId: () => 'generated-id',
    };
  });

  it('creates a product when authorized', async () => {
    const ctx = createContext({ roles: ['seller'] });

    const product = await createProduct(deps, ctx, validInput);

    expect(product.id).toBe('generated-id');
    expect(product.name).toBe('Test Product');
    expect(product.price).toBe(2999);
    expect(product.status).toBe('draft');
    expect(product.createdBy).toBe('user-1');
  });

  it('persists the product to repository', async () => {
    const ctx = createContext({ roles: ['seller'] });

    await createProduct(deps, ctx, validInput);

    const saved = await repository.findById('generated-id');
    expect(saved).not.toBeNull();
    expect(saved!.name).toBe('Test Product');
  });

  it('throws BusinessError when user is not authorized', async () => {
    const ctx = createContext({ roles: ['customer'] }); // Not seller or admin

    await expect(createProduct(deps, ctx, validInput))
      .rejects.toThrow(BusinessError);
  });

  it('allows admin to create products', async () => {
    const ctx = createContext({ roles: [], isAdmin: true });

    const product = await createProduct(deps, ctx, validInput);

    expect(product.id).toBe('generated-id');
  });
});
```

---

## Summary: Files Created

| Layer | File | Purpose |
|-------|------|---------|
| **Core - Entity** | `packages/core/src/products/Product.ts` | Business rules and state |
| **Core - Contract** | `packages/core/src/products/ProductRepository.ts` | Storage interface |
| **Core - Policies** | `packages/core/src/products/ProductPolicies.ts` | Authorization rules |
| **Core - Actions** | `packages/core/src/products/actions/createProduct.ts` | Create operation |
| **Core - Actions** | `packages/core/src/products/actions/updateProduct.ts` | Update operation |
| **Core - Actions** | `packages/core/src/products/actions/discontinueProduct.ts` | Discontinue operation |
| **Core - Index** | `packages/core/src/products/index.ts` | Barrel exports |
| **Infra - MongoDB** | `packages/infra/src/products/ProductRepositoryMongo.ts` | Real storage |
| **Infra - Memory** | `packages/infra/src/products/memory/InMemoryProductRepository.ts` | Test fake |
| **API - Validators** | `apps/client/pages/api/validators/productValidators.ts` | Input validation |
| **API - Handlers** | `apps/client/pages/api/products/index.ts` | HTTP handlers |
| **Entry - Deps** | `apps/client/server/dependencies.ts` | Wiring (additions) |
| **Tests** | `packages/core/src/products/Product.test.ts` | Entity tests |
| **Tests** | `packages/core/src/products/actions/createProduct.test.ts` | Action tests |

---

## Key Patterns Reinforced

| Pattern | Where You Saw It |
|---------|------------------|
| **Entity protects itself** | `Product.activate()` throws `InvariantError` |
| **Action orchestrates** | `discontinueProduct` loads, authorizes, validates, executes, persists |
| **Repository returns null** | `findById` returns `null`, action throws `NotFoundError` |
| **Deps are injected** | `generateId` injected for testability |
| **Handler validates, action decides** | Zod in handler, business rules in action |
| **Wire at startup** | All deps created in `dependencies.ts` singleton |

---

## Next Steps

Now that you've built a complete feature, explore:

- [Cross-Feature Communication](./13-cross-feature-communication.md) - How orders can check product stock
- [CQRS and Read Models](./11-cqrs-and-read-models.md) - Optimized queries for product listings
- [Transactions](./12-transactions.md) - Atomic operations across collections
