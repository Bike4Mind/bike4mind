---
title: Migration Compatibility Guide
description: Lessons learned from the Projects feature migration to the Simplified Hexagonal Architecture, to avoid common pitfalls.
sidebar_position: 21
---

:::caution Archived design reference — not the current architecture
These docs describe a proposed **Simplified Hexagonal Architecture** from an internal design exploration that was **not** adopted. The design **principles** (entity invariants, contracts, dependency inversion, load → authorize → validate → execute, in-memory-fake testing) remain useful, but the specifics below **do not exist in this codebase**: the package paths `packages/core` / `packages/infra` / `packages/shared`, the `@packages/*` import aliases, the `main.ts` wiring entry point, and the `EnableArchitectureTransition` feature flag. Do **not** follow the paths, aliases, or imports here as-is.
:::


# Migration Compatibility Guide

This document captures lessons learned from the Projects feature migration to the new Simplified Hexagonal Architecture. Use these guidelines when planning future feature transitions to avoid common pitfalls.

## Overview

When migrating features from the legacy architecture to the new hexagonal pattern, several compatibility issues can arise due to differences in conventions, field naming, and type handling between the two systems.

---

## 1. MongoDB ID Generation

### Issue
The new architecture's `UuidGenerator` produces UUID v4 strings (36 characters with dashes), but legacy MongoDB schemas expect ObjectId format (24 hex characters).

### Symptom
```
CastError: Cast to ObjectId failed for value "74aa2629-a4d5-4ea9-a1cf-cb8cfcea1d26"
at path "_id" for model "Project"
```

### Solution
Use `MongoIdGenerator` instead of `UuidGenerator` when working with legacy MongoDB schemas that don't explicitly define `_id` as String type.

```typescript
// ❌ Wrong - produces UUIDs incompatible with ObjectId
import { UuidGenerator } from '@packages/infra/shared';
const idGenerator = new UuidGenerator();

// ✅ Correct - produces ObjectId-compatible strings
import { MongoIdGenerator } from '@packages/infra/shared';
const idGenerator = new MongoIdGenerator();
```

### Prevention
Before implementing a feature migration, check:
- Does the legacy model explicitly define `_id` type?
- If not, use `MongoIdGenerator` for that feature

---

## 2. User/Member Field Naming

### Issue
The legacy `ShareableDocumentSchema` stores member user IDs in `users[].id`, but the new architecture naturally uses `users[].userId`.

### Symptom
Queries for shared documents (where user is a member, not owner) return empty results.

### Solution
Use `users.id` in MongoDB queries to match the legacy schema:

```typescript
// ❌ Wrong - field doesn't exist in legacy schema
{ 'users.userId': userId }

// ✅ Correct - matches legacy ShareableDocumentSchema
{ 'users.id': userId }
```

### Prevention
Before writing repository queries, examine the legacy schema:
```typescript
// Check packages/database/src/utils/mongo.ts for ShareableDocumentSchema
users: [{
  id: { type: String },        // ← This is the field name
  permissions: [{ type: String }],
  // ...
}]
```

---

## 3. Soft Delete Field Handling

### Issue
The legacy schema explicitly sets `deletedAt: null` for active documents, while the new architecture assumes `deletedAt` is undefined/missing for active documents.

### Symptom
- Active documents treated as deleted
- "Cannot perform action on deleted [entity]" errors
- Queries return empty results for existing data

### Solution

**In Repository Queries:**
```typescript
// ❌ Wrong - doesn't match documents with deletedAt: null
deletedAt: { $exists: false }

// ✅ Correct - matches both null AND missing field
deletedAt: null
```

**In Entity Checks:**
```typescript
// ❌ Wrong - null !== undefined is true
get isDeleted(): boolean {
  return this._deletedAt !== undefined;
}

// ✅ Correct - null != null is false
get isDeleted(): boolean {
  return this._deletedAt != null;
}
```

### Prevention
Check how the legacy model defines `deletedAt`:
```typescript
// packages/database/src/utils/mongo.ts
deletedAt: {
  type: Date,
  default: null,  // ← Explicitly null, not undefined
}
```

---

## 4. Query Parameter Type Conversion

### Issue
HTTP query parameters are always strings, but Zod validation schemas expect proper types (boolean, number, etc.).

### Symptom
```
400 Bad Request - validation failed
```

### Solution
Transform query parameters before validation:

```typescript
// String to Boolean
const filters = {
  favorite: queryParams.filters?.favorite === 'true',
};

// String to Number (already handled by Number())
const pagination = {
  page: Number(queryParams.pagination?.page) || 1,
  limit: Number(queryParams.pagination?.limit) || 20,
};
```

### Prevention
When creating API handlers, always add a transformation layer between `qs.parse()` and `schema.safeParse()`.

---

## 5. Field Name Mapping (Frontend ↔ Schema)

### Issue
Frontend may send different field names than what the validation schema expects (e.g., `orderBy.by` vs `orderBy.field`).

### Symptom
```
400 Bad Request - validation failed on orderBy
```

### Solution
Map legacy field names to new schema field names:

```typescript
// Support both old and new field names
const field = queryParams.orderBy?.field || queryParams.orderBy?.by;
const orderBy = {
  field,  // Schema expects 'field'
  direction: queryParams.orderBy?.direction || 'desc',
};
```

### Prevention
- Document the expected API contract clearly
- Consider supporting both old and new field names during transition
- Or update frontend simultaneously with backend

---

## 6. Permission Type Consistency

### Issue
Different implementations may use different permission names for the same concept, or use invalid permission names.

### Symptom
- Tests pass but production fails (or vice versa)
- Access control behaves differently between environments

### Solution
Always reference the canonical `Permission` type and use consistent values:

```typescript
// Permission type definition
type Permission = 'read' | 'create' | 'update' | 'delete' | 'share';

// ❌ Wrong - 'write' is not a valid permission
permissions: { $in: ['read', 'write', 'update'] }

// ✅ Correct - use only valid permission values
permissions: { $in: ['read', 'update'] }
```

### Prevention
- Define Permission type in one place (core layer)
- Ensure all implementations reference the same type
- Add tests that verify both MongoDB and InMemory implementations have identical behavior

---

## Migration Checklist

Before starting a feature migration, verify:

| Check | Question | Action if Yes |
|-------|----------|---------------|
| **ID Format** | Does legacy schema use ObjectId for `_id`? | Use `MongoIdGenerator` |
| **User Fields** | Does legacy use `users[].id` for members? | Query with `users.id` not `users.userId` |
| **Soft Delete** | Does legacy set `deletedAt: null` for active? | Use `deletedAt: null` in queries, `!= null` in entity |
| **Query Params** | Does API accept query parameters? | Add transformation layer before validation |
| **Field Names** | Do frontend field names match schema? | Add mapping or update frontend |
| **Permissions** | Are permission values consistent? | Verify against canonical Permission type |

---

## Testing Recommendations

1. **Test with real legacy data** - Don't just test with freshly created data; test with existing production-like data that was created by the legacy system.

2. **Compare query results** - Run both legacy and new implementations against the same data and compare results.

3. **Test edge cases**:
   - Documents created by legacy system
   - Documents with `deletedAt: null` vs missing field
   - Shared documents (user is member, not owner)
   - Query parameters with string booleans

4. **Use feature flags** - The `EnableArchitectureTransition` flag allows A/B testing between old and new implementations.

---

## Summary Table

| Issue | Legacy Convention | New Architecture Assumption | Fix |
|-------|-------------------|----------------------------|-----|
| ID format | ObjectId (24 hex) | UUID (36 chars) | Use `MongoIdGenerator` |
| Member field | `users[].id` | `users[].userId` | Use legacy field name |
| Soft delete | `deletedAt: null` | `deletedAt: undefined` | Query with `null`, check with `!= null` |
| Query params | Strings | Typed values | Transform before validation |
| Permissions | May vary | Canonical type | Align all implementations |
