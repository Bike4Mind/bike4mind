import { configDefaults, defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    ...sharedTest,
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__test__/setupKeyring.ts'],
    include: ['**/*.test.ts'],
    ...(process.env.REPO_TEST_LANE === 'repo'
      ? { include: ['**/*.repo.test.ts'] }
      : { exclude: [...configDefaults.exclude, '**/*.repo.test.ts'] }),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '**/*.test.ts', 'vitest.config.ts'],
    },
  },
});
