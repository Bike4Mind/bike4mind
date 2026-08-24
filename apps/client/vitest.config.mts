import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';
import path from 'path';
// @vitejs/plugin-react v6 requires Vite 8 (it imports the `vite/internal`
// subpath). Vite is otherwise only a transitive peer of vitest. Declaring
// `vite` as an explicit devDependency here is the lever that satisfies
// plugin-react 6's strict `^8` peer — pnpm then unifies vite to 8 workspace-wide
// for every vitest package (safe: vitest 4 accepts vite ^6 || ^7 || ^8). This
// vite devDep and the plugin-react v6 bump are coupled — keep both or revert both.
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

const INTEGRATION_LANE = process.env.CLIENT_TEST_LANE === 'integration';

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    ...sharedTest,
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
    // Raise the 15s shared floor to 30s. Load-bearing for the integration lane below, which
    // holds ~20 real-Mongo suites (createMongoServer/createMongoReplSet): their first write
    // per worker pays an
    // unavoidable, legitimate cold-start: Mongoose builds every model's indexes on connect
    // (needed for correctness - the rate-limit suite depends on one, so autoIndex CANNOT be
    // disabled) plus first-collection creation. Measured at 16-22s under that lane's file
    // parallelism, so 15s (a unit-test budget) fails 4-ish suites at random - the exact flake.
    // This is not a hang mask: it is the right budget for integration tests. Attempts to shrink
    // the cold-start instead were dead ends - autoIndex:false breaks index-dependent suites, and
    // a single shared mongod serializes every worker's index builds and made it markedly worse.
    testTimeout: 30000,
    // Two lanes over one config, selected by CLIENT_TEST_LANE (set only by the
    // `test:integration` script). The ~20 `*.e2e.test.ts` files each boot a real
    // mongod, and running them inline pushed this shard's job past its 20-minute
    // CI budget even though the suite itself passed - so they get their own
    // matrix shard. One config rather than two so the aliases, setup file and
    // environment cannot drift between the lanes.
    // NOTE: `test:e2e` in package.json is Playwright, NOT these files. The
    // Playwright directory is the bare 'e2e' exclusion below.
    ...(INTEGRATION_LANE ? { include: ['**/*.e2e.test.ts'] } : {}),
    exclude: [
      '**/node_modules/**',
      'e2e',
      '.next/**',
      '.open-next/**',
      ...(INTEGRATION_LANE ? [] : ['**/*.e2e.test.ts']),
    ],
  },
  resolve: {
    alias: {
      '@server': path.resolve(__dirname, 'server'),
      '@client': path.resolve(__dirname, '.'),
      '@pages': path.resolve(__dirname, 'pages'),
      '@public': path.resolve(__dirname, 'public'),
      '@/': `${path.resolve(__dirname, '.')}/`,
      crypto: 'node:crypto',
    },
  },
  define: {
    global: 'globalThis',
    'process.env': {},
  },
  optimizeDeps: {
    include: ['uuid'],
  },
});
