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
    ...(process.env.REPO_TEST_LANE === 'repo'
      ? { include: ['**/*.repo.test.ts'] }
      : { exclude: ['**/node_modules/**', '**/*.repo.test.ts'] }),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '**/*.test.ts', 'vitest.config.ts'],
    },
  },
});
