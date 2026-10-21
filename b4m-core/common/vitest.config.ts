import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTest,
    globals: true,
    environment: 'node',
    // Type-level tests (`*.test-d.ts`) run through tsc here; the package tsconfig keeps test files out of `typecheck`.
    typecheck: { enabled: true, include: ['src/**/*.test-d.ts'] },
  },
});
