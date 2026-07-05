import { defineConfig } from 'vitest/config';
import { sharedTest } from './vitest.shared';

export default defineConfig({
  test: {
    ...sharedTest,
    // global configuration options
  },
});
