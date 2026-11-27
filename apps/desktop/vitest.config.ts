import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@bike4mind/cli/skills': resolve(__dirname, '../../packages/cli/src/skills/index.ts'),
    },
  },
  test: {
    ...sharedTest,
    environment: 'node',
    globalSetup: [resolve(__dirname, 'vitest.globalSetup.ts')],
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
    // `*.repo.test.*` run only from `test:repo` (CI's misc leg, uncached): they build or read
    // beyond this package and are slow by design.
    ...(process.env.REPO_TEST_LANE === 'repo'
      ? { include: ['src/**/*.repo.test.ts'] }
      : {
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, '**/*.repo.test.ts'],
        }),
    reporters: ['default', resolve(__dirname, 'vitest.budgetReporter.ts')],
  },
});
