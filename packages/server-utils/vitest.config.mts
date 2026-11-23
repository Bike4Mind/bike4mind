import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

// Same lanes as apps/client/vitest.config.mts, selected by SERVER_UTILS_TEST_LANE:
// - `test:integration`: the real-Mongo `*.e2e.test.ts` suites, which CI gives its own leg with a
//   capped worker pool. Inline with the unit suites they contend for mongod and flake.
// - `test:repo`: the `*.repo.test.*` files, which read the repo far outside this package (`git grep`
//   over every tracked file). CI runs that lane uncached on the misc leg;
//   scripts/__tests__/turbo-test-cache.test.mjs requires the script wherever such files exist.
const INTEGRATION_LANE = process.env.SERVER_UTILS_TEST_LANE === 'integration';
const REPO_LANE = process.env.SERVER_UTILS_TEST_LANE === 'repo' || process.env.REPO_TEST_LANE === 'repo';
// Every extension the guard's REPO_LANE_FILE accepts, so no file it treats as uncached runs in a
// cached lane.
const REPO_LANE_GLOB = '**/*.repo.test.?(c|m)[jt]s?(x)';

const laneFiles = INTEGRATION_LANE
  ? { include: ['**/*.e2e.test.ts'], exclude: ['**/node_modules/**', REPO_LANE_GLOB] }
  : REPO_LANE
    ? { include: [REPO_LANE_GLOB], exclude: ['**/node_modules/**', '**/*.e2e.test.ts'] }
    : { exclude: ['**/node_modules/**', '**/*.e2e.test.ts', REPO_LANE_GLOB] };

export default defineConfig({
  test: {
    ...sharedTest,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    ...laneFiles,
    // Integration-lane only, as in apps/workers: unset in the unit lane, where a retry would mask
    // a real bug. Guarded by vitest.config.test.ts.
    ...(INTEGRATION_LANE ? { retry: 2 } : {}),
  },
});
