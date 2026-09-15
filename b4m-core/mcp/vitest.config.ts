import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

// Minimal config: applies the shared worker-pool budget (see vitest.shared.ts)
// while preserving vitest's defaults this package previously ran with.
export default defineConfig({
  test: { ...sharedTest },
});
