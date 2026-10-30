import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

// Same two lanes as apps/workers/vitest.config.mts: the real-Mongo `*.e2e.test.ts` suites run only
// under `test:integration`, which CI gives its own leg with a capped worker pool. Inline with the
// unit suites they contend for mongod and flake.
const INTEGRATION_LANE = process.env.SERVER_UTILS_TEST_LANE === 'integration';

export default defineConfig({
  test: {
    ...sharedTest,
    environment: 'node',
    ...(INTEGRATION_LANE ? { include: ['**/*.e2e.test.ts'] } : { exclude: ['**/node_modules/**', '**/*.e2e.test.ts'] }),
    // Integration-lane only, as in apps/workers: unset in the unit lane, where a retry would mask
    // a real bug. Guarded by vitest.config.test.ts.
    ...(INTEGRATION_LANE ? { retry: 2 } : {}),
  },
});
