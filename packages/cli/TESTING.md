# B4M CLI Testing Guide

This guide explains how to write and run tests for the B4M CLI application.

## Overview

The B4M CLI uses:
- **Test Framework**: Vitest 3.2.4
- **Component Testing**: ink-testing-library 4.0.0 (for Ink React components)
- **Mocking**: Vitest's built-in mocking utilities

## Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode (re-runs on file changes)
pnpm test:watch

# Run specific test file
pnpm test PermissionManager

# Run with coverage
pnpm test --coverage
```

## Project Structure

```
packages/cli/src/
├── components/          # Ink React components
│   ├── MessageItem.tsx
│   └── MessageItem.test.tsx
├── storage/            # Persistence layer
│   ├── SessionStore.ts
│   └── SessionStore.test.ts
├── utils/              # Utility functions
│   ├── PermissionManager.ts
│   ├── PermissionManager.test.ts
│   ├── messageBuilder.ts
│   └── messageBuilder.test.ts
└── test-utils/         # Shared test utilities
    ├── setupTests.ts    # Global test setup
    ├── testHelpers.ts   # Helper functions
    ├── mocks.ts         # Mock objects
    └── fixtures.ts      # Test data
```

## Test Utilities

### Fixtures

Reusable test data for consistent testing:

```typescript
import { fixtures } from '../test-utils/fixtures';

// Use pre-built test messages
const message = fixtures.messages.userMessage;

// Use pre-built test sessions
const session = fixtures.sessions.activeSession;

// Use pre-built test configs
const config = fixtures.configs.defaultConfig;
```

### Mocks

Common mock objects for testing:

```typescript
import {
  createMockMessage,
  createMockSession,
  createMockConfig,
  createMockSessionStore,
} from '../test-utils/mocks';

// Create mock message with overrides
const message = createMockMessage({
  role: 'user',
  content: 'Test message',
});

// Create mock session
const session = createMockSession({
  name: 'Test Session',
  messages: [message],
});

// Create mock SessionStore
const mockStore = createMockSessionStore();
await mockStore.save(session);
```

### Test Helpers

Utility functions for common test operations:

```typescript
import {
  createMockFs,
  waitFor,
  flushPromises,
  mockDate,
} from '../test-utils/testHelpers';

// Mock filesystem
const mockFs = createMockFs();
mockFs.writeFileSync('/test/file.txt', 'content');

// Wait for condition
await waitFor(() => someCondition === true, { timeout: 1000 });

// Flush all promises
await flushPromises();

// Mock Date
const cleanup = mockDate('2026-01-15T12:00:00.000Z');
// ... test code ...
cleanup();
```

## Writing Tests

### Utility Tests

Test pure functions with mocked dependencies:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MyUtility } from './MyUtility';

describe('MyUtility', () => {
  let utility: MyUtility;

  beforeEach(() => {
    vi.clearAllMocks();
    utility = new MyUtility();
  });

  describe('myMethod', () => {
    it('should perform expected behavior', () => {
      const result = utility.myMethod('input');
      expect(result).toBe('expected-output');
    });

    it('should handle edge cases', () => {
      const result = utility.myMethod('');
      expect(result).toBe('default-value');
    });
  });
});
```

### Ink Component Tests

Test Ink React components with ink-testing-library:

```typescript
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MyComponent } from './MyComponent';

describe('MyComponent', () => {
  it('should render text content', () => {
    const { lastFrame } = render(<MyComponent text="Hello" />);

    expect(lastFrame()).toContain('Hello');
  });

  it('should handle user interactions', () => {
    const { stdin, lastFrame } = render(<MyComponent />);

    // Simulate user input
    stdin.write('y');

    expect(lastFrame()).toContain('Yes selected');
  });
});
```

### Storage/Persistence Tests

Test file operations with mocked filesystem:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import { MyStore } from './MyStore';

// Mock the fs module
vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
  },
}));

describe('MyStore', () => {
  it('should save data to disk', async () => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    const store = new MyStore('/test-path');
    await store.save({ id: '1', data: 'test' });

    expect(fs.writeFile).toHaveBeenCalledWith(
      '/test-path/1.json',
      expect.any(String),
      'utf-8'
    );
  });
});
```

## Testing Best Practices

### 1. Arrange-Act-Assert (AAA) Pattern

Structure tests with clear sections:

```typescript
it('should calculate total correctly', () => {
  // Arrange
  const items = [{ price: 10 }, { price: 20 }];
  const calculator = new Calculator();

  // Act
  const total = calculator.calculateTotal(items);

  // Assert
  expect(total).toBe(30);
});
```

### 2. Descriptive Test Names

Use clear, descriptive test names:

```typescript
// ❌ Bad
it('works', () => { ... });

// ✅ Good
it('should return null for non-existent session', () => { ... });
```

### 3. Test One Thing Per Test

Keep tests focused on a single behavior:

```typescript
// ❌ Bad - testing multiple things
it('should handle CRUD operations', async () => {
  await store.create(item);
  await store.read(item.id);
  await store.update(item);
  await store.delete(item.id);
});

// ✅ Good - separate tests
it('should create new item', async () => { ... });
it('should read existing item', async () => { ... });
it('should update item', async () => { ... });
it('should delete item', async () => { ... });
```

### 4. Mock External Dependencies

Mock filesystem, network calls, and heavy dependencies:

```typescript
import { vi } from 'vitest';

// Mock module
vi.mock('axios');

// Mock function
const mockFn = vi.fn().mockResolvedValue('result');

// Mock implementation
vi.mocked(axios.get).mockImplementation(async (url) => {
  return { data: 'mocked data' };
});
```

### 5. Test Edge Cases

Don't just test the happy path:

```typescript
describe('divide', () => {
  it('should divide two numbers', () => {
    expect(divide(10, 2)).toBe(5);
  });

  it('should handle division by zero', () => {
    expect(() => divide(10, 0)).toThrow('Cannot divide by zero');
  });

  it('should handle negative numbers', () => {
    expect(divide(-10, 2)).toBe(-5);
  });

  it('should handle decimal results', () => {
    expect(divide(10, 3)).toBeCloseTo(3.333, 3);
  });
});
```

### 6. Use TypeScript Strictly

Avoid `any` types in tests:

```typescript
// ❌ Bad
const mockStore: any = {
  save: vi.fn(),
};

// ✅ Good
const mockStore: SessionStore = {
  save: vi.fn(),
  load: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
} as any; // Only use 'as any' for the entire mock object, not individual properties
```

### 7. Clean Up After Tests

Use beforeEach/afterEach for setup and cleanup:

```typescript
import { beforeEach, afterEach, vi } from 'vitest';

let cleanup: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  cleanup = mockDate('2026-01-15T00:00:00.000Z');
});

afterEach(() => {
  if (cleanup) cleanup();
  vi.restoreAllMocks();
});
```

## Common Patterns

### Testing Async Operations

```typescript
it('should handle async operations', async () => {
  const promise = asyncFunction();
  await expect(promise).resolves.toBe('success');
});

it('should handle async errors', async () => {
  const promise = failingAsyncFunction();
  await expect(promise).rejects.toThrow('Error message');
});
```

### Testing Error Handling

```typescript
it('should throw error for invalid input', () => {
  expect(() => {
    myFunction(null);
  }).toThrow('Invalid input');
});

it('should handle ENOENT filesystem errors', async () => {
  const error: any = new Error('File not found');
  error.code = 'ENOENT';
  vi.mocked(fs.readFile).mockRejectedValue(error);

  const result = await store.load('missing');
  expect(result).toBeNull();
});
```

### Testing with Timers

```typescript
import { vi } from 'vitest';

it('should debounce function calls', () => {
  vi.useFakeTimers();

  const mockFn = vi.fn();
  const debounced = debounce(mockFn, 100);

  debounced();
  debounced();
  debounced();

  // Should not be called yet
  expect(mockFn).not.toHaveBeenCalled();

  // Fast forward time
  vi.advanceTimersByTime(100);

  // Should be called once
  expect(mockFn).toHaveBeenCalledTimes(1);

  vi.useRealTimers();
});
```

## Coverage Goals

- **Critical Security Code** (PermissionManager): 100% coverage required
- **Storage Layer** (SessionStore, ConfigStore): >90% coverage
- **Utilities** (messageBuilder, formatters): >80% coverage
- **Components** (UI elements): >70% coverage
- **Overall Project**: >75% coverage

## Troubleshooting

### Tests Failing with "Cannot find module"

Ensure imports use correct paths:

```typescript
// ✅ Correct - relative imports
import { MyClass } from './MyClass';
import { helper } from '../utils/helper';

// ❌ Incorrect - bare imports without proper config
import { MyClass } from 'src/MyClass';
```

### Ink Component Tests Not Rendering

Make sure ink-testing-library is installed:

```bash
pnpm install -D ink-testing-library
```

### Mock Not Working

Ensure mock is defined before importing the module:

```typescript
// ✅ Correct order
vi.mock('fs');
import { MyClass } from './MyClass'; // Uses mocked fs

// ❌ Incorrect order
import { MyClass } from './MyClass'; // Uses real fs
vi.mock('fs'); // Too late
```

### Type Errors with Mocks

Use `vi.mocked()` for type safety:

```typescript
import { vi } from 'vitest';
import axios from 'axios';

vi.mock('axios');

// ✅ Type-safe
vi.mocked(axios.get).mockResolvedValue({ data: 'test' });

// ❌ Not type-safe
(axios.get as any).mockResolvedValue({ data: 'test' });
```

## CI Integration

Tests run automatically in GitHub Actions on every PR and push to main.

```yaml
# .github/workflows/test.yml
- name: Run CLI tests
  run: pnpm --filter @bike4mind/cli test
```

## Additional Resources

- [Vitest Documentation](https://vitest.dev/)
- [ink-testing-library](https://github.com/vadimdemedes/ink-testing-library)
- [Vitest Mocking Guide](https://vitest.dev/guide/mocking.html)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)

## Test Coverage Summary

Current test coverage:

| Module | Test File | Tests | Status |
|--------|-----------|-------|--------|
| PermissionManager | PermissionManager.test.ts | 49 | ✅ |
| MessageBuilder | messageBuilder.test.ts | 30 | ✅ |
| MessageItem | MessageItem.test.tsx | 12 | ✅ |
| SessionStore | SessionStore.test.ts | 32 | ✅ |
| **Total** | **4 test files** | **123 tests** | **✅** |

## Contributing

When adding new features:

1. Write tests alongside your code
2. Follow the patterns established in existing tests
3. Use the test utilities in `/src/test-utils/`
4. Ensure all tests pass before creating a PR
5. Aim for >80% coverage on new code

For questions or issues, please refer to the main [CLAUDE.md](../../CLAUDE.md) documentation.
