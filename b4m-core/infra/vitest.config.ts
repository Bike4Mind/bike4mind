import { configDefaults, defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTest,
    ...(process.env.REPO_TEST_LANE === 'repo'
      ? { include: ['**/*.repo.test.ts'] }
      : { exclude: [...configDefaults.exclude, '**/*.repo.test.ts'] }),
    globals: true,
    environment: 'node',
  },
});
