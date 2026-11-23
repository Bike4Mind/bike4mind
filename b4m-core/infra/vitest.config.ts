import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTest,
    ...(process.env.REPO_TEST_LANE === 'repo'
      ? { include: ['**/*.repo.test.ts'] }
      : { exclude: ['**/node_modules/**', '**/*.repo.test.ts'] }),
    globals: true,
    environment: 'node',
  },
});
