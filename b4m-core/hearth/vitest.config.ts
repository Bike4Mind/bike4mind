import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

// Minimal config: applies the shared worker-pool budget (see vitest.shared.ts).
export default defineConfig({
  test: { ...sharedTest },
});
