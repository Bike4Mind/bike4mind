import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    ...sharedTest,
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '**/*.test.ts', 'vitest.config.ts'],
    },
  },
});
