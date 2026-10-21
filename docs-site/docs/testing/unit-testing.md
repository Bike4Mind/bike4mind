---
sidebar_position: 1
title: "Unit Testing with Vitest"
content_type: ["how-to", "reference"]
feature_status: stable
audience: ["developers"]
spiciness: medium
visibility: public
maturity: approved
related_features: ["testing", "quality"]
tags: ["testing", "api", "database", "typescript"]
last_reviewed: 2025-06-30
---

# Unit Testing with Vitest

This guide covers our unit testing practices using Vitest, including setup, writing tests, and best practices.

## Overview

We use Vitest as our testing framework, which provides a fast and modern testing experience with excellent TypeScript support. Our tests are organized alongside the code they test, following the pattern of `*.test.ts` or `*.spec.ts` files.

## Test Structure

Our tests follow a consistent structure:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Component or Function Name', () => {
  beforeEach(() => {
    // Setup code before each test
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup code after each test
  });

  it('should do something specific', async () => {
    // Test implementation
  });
});
```

## Key Testing Features

### Mocking

We use Vitest's built-in mocking capabilities:

```typescript
// Mocking modules
vi.mock('./module', () => ({
  functionName: vi.fn(),
}));

// Mocking specific functions
vi.spyOn(object, 'method').mockImplementation(() => {
  // Custom implementation
});
```

### Testing Async Code

```typescript
it('should handle async operations', async () => {
  const result = await asyncFunction();
  expect(result).toBe(expectedValue);
});
```

### Testing Error Cases

```typescript
it('should throw error on invalid input', async () => {
  await expect(asyncFunction(invalidInput))
    .rejects
    .toThrow(ExpectedError);
});
```

## Best Practices

1. **Isolation**: Each test should be independent and not rely on the state of other tests
2. **Clear Descriptions**: Test descriptions should clearly state what is being tested
3. **Mock External Dependencies**: Use mocks for external services, databases, and APIs
4. **Test Edge Cases**: Include tests for error conditions and edge cases
5. **Use TypeScript**: Leverage TypeScript for better type safety in tests

## Running Tests

Tests can be run using the following commands:

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests for a specific file
pnpm test path/to/test/file.test.ts
```

## Example Test Files

### API Handler Test Example

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { secretCache } from '../utils/secretCache';
import { connectDB } from '@bike4mind/database';
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../utils/errors';

describe('Secret caching in API handlers', () => {
  const mockHandler = vi.fn();
  const mockReq = { headers: {} };
  const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch secrets and connect to database', async () => {
    // Test implementation
  });
});
```

### Utility Test Example

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secretCache, SecretCacheManager } from './secretCache';

describe('SecretCacheManager', () => {
  beforeEach(() => {
    secretCache.clearCache();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return the same instance on multiple calls', () => {
    const instance1 = SecretCacheManager.getInstance();
    const instance2 = SecretCacheManager.getInstance();
    expect(instance1).toBe(instance2);
  });
});
```

## Common Testing Patterns

1. **Setup and Teardown**: Use `beforeEach` and `afterEach` for consistent test environment
2. **Mocking Dependencies**: Mock external services and dependencies
3. **Assertions**: Use Vitest's assertion library for clear and readable tests
4. **Async Testing**: Properly handle asynchronous code with async/await
5. **Error Testing**: Test both success and error cases

## Tips and Tricks

- Use `vi.useFakeTimers()` for testing time-dependent code
- Leverage TypeScript's type system to catch errors early
- Keep tests focused and test one thing at a time
- Use descriptive test names that explain the expected behavior
- Mock external services to keep tests fast and reliable 