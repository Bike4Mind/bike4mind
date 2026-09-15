/**
 * Shared test helper functions
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * Creates a mock filesystem for testing file operations
 */
export function createMockFs() {
  const files = new Map<string, string>();

  return {
    readFileSync: vi.fn((path: string) => {
      const content = files.get(path);
      if (!content) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return content;
    }),
    writeFileSync: vi.fn((path: string, content: string) => {
      files.set(path, content);
    }),
    existsSync: vi.fn((path: string) => files.has(path)),
    unlinkSync: vi.fn((path: string) => {
      files.delete(path);
    }),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => Array.from(files.keys())),
    // Helper to seed files for tests
    _setFile: (path: string, content: string) => {
      files.set(path, content);
    },
    // Helper to get all files
    _getFiles: () => files,
    // Helper to clear all files
    _clear: () => {
      files.clear();
    },
  };
}

/**
 * Wait for async operations to complete
 */
export async function waitFor(
  callback: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 1000, interval = 50 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await callback();
    if (result) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error('waitFor timeout exceeded');
}

/**
 * Flushes all pending promises
 */
export async function flushPromises(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

/**
 * Creates a spy that tracks calls and can be asserted on
 */
export function createSpy<T extends (...args: any[]) => any>(): Mock<T> {
  return vi.fn() as Mock<T>;
}

/**
 * Assert that a mock was called with specific arguments
 */
export function assertCalledWith<T extends any[]>(mock: Mock, ...args: T): void {
  const calls = mock.mock.calls;
  const found = calls.some(call => {
    if (call.length !== args.length) return false;
    return call.every((arg, index) => {
      const expected = args[index];
      return JSON.stringify(arg) === JSON.stringify(expected);
    });
  });

  if (!found) {
    throw new Error(
      `Expected mock to be called with ${JSON.stringify(args)}, but it was called with: ${JSON.stringify(calls)}`
    );
  }
}

/**
 * Create a mock Date for consistent time-based testing
 */
export function mockDate(dateString: string): () => void {
  const mockDate = new Date(dateString);
  const originalDate = global.Date;

  global.Date = class extends Date {
    constructor() {
      super();
      return mockDate;
    }

    static now() {
      return mockDate.getTime();
    }
  } as any;

  // Return cleanup function
  return () => {
    global.Date = originalDate;
  };
}

/**
 * Create a mock implementation that returns different values on subsequent calls
 */
export function mockSequence<T>(...values: T[]): Mock {
  let callIndex = 0;
  return vi.fn(() => {
    const value = values[callIndex];
    callIndex = Math.min(callIndex + 1, values.length - 1);
    return value;
  });
}
