import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTest,
    // Download MongoDB binary once before all tests to prevent race conditions
    globalSetup: './vitest.setup.ts',
    // Increase timeout to allow for MongoDB binary download and operations
    hookTimeout: 60000,
  },
});
