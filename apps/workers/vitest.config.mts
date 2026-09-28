import { defineConfig } from 'vitest/config';
import path from 'path';
import tsconfigPaths from 'vite-tsconfig-paths';
import { sharedTest } from '../../vitest.shared';

const client = path.resolve(__dirname, '../client');

// Same two lanes as apps/client/vitest.config.mts, selected the same way: the real-Mongo
// `*.e2e.test.ts` suites run only under `test:integration`, which CI gives its own leg with a
// capped worker pool. Inline with the unit suites they contend for mongod and flake.
const INTEGRATION_LANE = process.env.WORKERS_TEST_LANE === 'integration';
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    // Mirrors apps/client/vitest.config.mts so the interim @server/@client bridge resolves the
    // same way under test as it does in tsconfig.json.
    alias: {
      '@workers': path.resolve(__dirname, 'src'),
      '@server': path.join(client, 'server'),
      '@client': client,
      '@pages': path.join(client, 'pages'),
      '@public': path.join(client, 'public'),
      '@/': `${client}/`,
      crypto: 'node:crypto',
    },
  },
  test: {
    ...sharedTest,
    globals: true,
    environment: 'node',
    ...(INTEGRATION_LANE ? { include: ['**/*.e2e.test.ts'] } : { exclude: ['**/node_modules/**', '**/*.e2e.test.ts'] }),
    // Shared with apps/client: the sst Resource mock and env seeds the moved suites relied on.
    setupFiles: [path.join(client, 'vitest.setup.ts')],
    testTimeout: 30000,
  },
});
