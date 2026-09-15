import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTest,
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
