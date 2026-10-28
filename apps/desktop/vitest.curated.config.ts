import { defineConfig } from 'vitest/config';
import desktopConfig from './vitest.config';

// Override include instead of merging its array with the ordinary unit-test list.
export default defineConfig({
  ...desktopConfig,
  test: {
    ...desktopConfig.test,
    include: ['src/main/models/curated.live.ts'],
    testTimeout: 30 * 60_000,
  },
});
