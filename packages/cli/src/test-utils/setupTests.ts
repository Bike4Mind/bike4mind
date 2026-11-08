/**
 * Global test setup file
 * Loaded before each test suite runs
 */

import { beforeEach, afterEach, vi } from 'vitest';

// Tests never read the Desktop install on the machine running them; a test that wants a settings file names it.
process.env.B4M_DESKTOP_MODEL_SETTINGS = 'off';

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Cleanup after each test
afterEach(() => {
  vi.restoreAllMocks();
});

// Mock console methods to reduce noise in test output
// Tests can override these if they need to verify console output
global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
