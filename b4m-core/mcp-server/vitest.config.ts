import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

// Applies the shared worker-pool budget (see vitest.shared.ts) on top of vitest's defaults.
export default defineConfig({
  test: { ...sharedTest },
});
