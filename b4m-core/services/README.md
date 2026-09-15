# Bike4Mind Services Documentation

## Overview

This directory contains the core business logic services for the B4M application. Each service is organized into its own module and follows specific patterns for consistency and maintainability.

## Directory Structure

```
services/
├── someService/
│   ├── index.ts                # Exports all operations
│   ├── create.ts               # Create operation
│   ├── create.test.ts          # Tests for create operation
│   ├── update.ts               # Update operation
│   ├── update.test.ts          # Tests for update operation
│   └── [other-operations].ts   # Additional operations + corresponding tests
├── __tests__/
│   └── utils/
│       └── testUtils.ts        # Shared test utilities (e.g., mock creation)
└── index.ts                    # Root exports for all services
```

## Service Operation Pattern

### 1. File Components

Each operation consists of two files:

- Main operation file (e.g., `create.ts`)
  - Schema definition (using Zod)
  - Types definition
  - Adapters interface
  - Main operation functo
- Test file (e.g., `create.test.ts`)
  - Test suite for the operation
  - Mock setups
  - Test cases

### 2. Standard Code Structure

```typescript
// 1. Imports
import { IRepository } from '@b4m-core/common';
import { secureParameters } from '@b4m-core/utils';
import { z } from 'zod';

// 2. Schema Definition
const operationSchema = z.object({
  // Define parameters using Zod
});

type OperationParameters = z.infer<typeof operationSchema>;

// 3. Adapters Interface
interface OperationAdapters {
  db: {
    someRepo: IRepository;
  };
}

// 4. Main Function Export
export const operation = async (
  user: string | IUserDocument,
  params: OperationParameters,
  adapters: OperationAdapters
) => {
  // Implementation
};
```

## Testing Structure

### 1. Test File Location

- Test files (`*.test.ts`) are co-located with their corresponding operation files within the service directory (e.g., `someService/create.ts` and `someService/create.test.ts`).
- Shared testing utilities are placed in the root `__tests__/utils/` directory.

### 2. Test File Pattern (using Vitest)

```typescript
// 1. Imports (vitest, operation, mocks, types)
import { describe, it, expect, beforeEach, Mock } from 'vitest';
import { operation } from './operation'; // Adjust path as needed
import { createMockRepository } from '../__tests__/utils/testUtils'; // Adjust path as needed
import { IRepository, IUserDocument } from '@b4m-core/common'; // Example types

describe('serviceModule - operation', () => {
  // 2. Common variables and types
  const userId = 'test-user-id'; // Example user ID
  let mockRepo: IRepository; // Use specific repo type
  let adapters: { db: { specificRepo: IRepository } }; // Match operation's adapter structure

  // 3. Setup mocks before each test
  beforeEach(() => {
    mockRepo = createMockRepository(); // Use specific mock creator
    adapters = {
      db: {
        specificRepo: mockRepo, // Assign mock to correct adapter property
      },
    };
    // Reset mocks if necessary: (mockRepo.someMethod as Mock).mockClear();
  });

  // 4. Test cases using Arrange-Act-Assert (AAA) pattern
  it('should handle successful operation', async () => {
    // Arrange
    const params = { /* valid parameters */ };
    const expectedResult = { /* expected outcome */ };
    // Configure mock return values: (mockRepo.someMethod as Mock).mockResolvedValueOnce(expectedResult);

    // Act
    const result = await operation(userId, params, adapters);

    // Assert
    expect(result).toEqual(expectedResult);
    // Verify mock calls: expect(mockRepo.someMethod).toHaveBeenCalledWith(/* expected arguments */);
  });

  it('should handle validation errors', async () => {
    // Arrange
    const invalidParams = { /* invalid parameters */ };

    // Act & Assert
    await expect(operation(userId, invalidParams, adapters))
      .rejects.toThrow(/* Optional: Specific error type or message */);
  });

  // Add more tests for other scenarios (error handling, edge cases, access control)
});
```

### 3. Test Coverage Requirements

Each operation should include tests for:

- Happy path (successful operation)
- Parameter validation
- Error handling
- Access control (if applicable)
- Edge cases

### 4. Mock Utilities

- Use `__tests__/utils/testUtils.ts` for common mock creation functions (e.g., `createMockUserRepository`).
- Follow repository interface contracts defined in `@b4m-core/common`.

## Implementation Guidelines

### 1. Parameter Validation

- Use `secureParameters` for input validation
- Define schemas using Zod
- Export schema if needed by other operations

### 2. Access Control

- Use repository shareable methods
- Verify entity existence and accessibility
- Include proper error handling

### 3. Error Handling

- Use custom error classes from @b4m-core/utils
- Common errors:
  - NotFoundError: Entity not found
  - UnauthorizedError: User lacks permission
  - ValidationError: Invalid input

### 4. Data Updates

- Update updatedAt timestamp when modifying entities
- Use immutable patterns for array updates
- Perform atomic operations through repositories

### 5. Repository Usage

- Access database through repository interfaces
- Use specialized repository methods
- Define repository interfaces in @b4m-core/common

## Creating New Features

1. Create operation file with descriptive name
2. Create corresponding test file
3. Follow the standard code structure
4. Implement required validations
5. Add comprehensive tests
6. Export in service's index.ts
7. Export service in root index.ts

## Best Practices

1. **Code Organization**
   - Keep operations focused and single-purpose
   - Document complex logic with comments
   - Use TypeScript features for type safety

2. **Testing**
   - Follow AAA pattern (Arrange, Act, Assert)
   - Mock external dependencies
   - Test both success and failure cases
   - Maintain test isolation

3. **Type Safety**
   - Use TypeScript interfaces
   - Leverage Zod for runtime validation
   - Maintain type consistency in tests

4. **Documentation**
   - Add JSDoc comments for complex functions
   - Document non-obvious test scenarios
   - Keep README updated with new patterns

## Why This Pattern?

1. **Decoupling**: Services are independent of external configurations
2. **Testability**: Easy to mock dependencies and test logic
3. **Maintainability**: Consistent structure makes code predictable
4. **Type Safety**: Strong typing with TypeScript and Zod
5. **Access Control**: Built-in security through repository patterns

## Usage Example

```typescript
// Server API implementation
import { someOperation } from '@b4m-core/services';
import { Repository } from 'models';

router.post('/endpoint', async (req, res) => {
  const result = await someOperation(
    req.user.id,
    req.body,
    {
      db: {
        repository: Repository
      }
    }
  );
  
  res.json(result);
});
```
