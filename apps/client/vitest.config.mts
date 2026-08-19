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

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    ...sharedTest,
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
    // Raise the 15s shared floor to 30s for THIS shard. It holds ~18 real-Mongo integration
    // suites (createMongoServer/createMongoReplSet), and their first write per worker pays an
    // unavoidable, legitimate cold-start: Mongoose builds every model's indexes on connect
    // (needed for correctness - the rate-limit suite depends on one, so autoIndex CANNOT be
    // disabled) plus first-collection creation. Measured at 16-22s under this shard's file
    // parallelism, so 15s (a unit-test budget) fails 4-ish suites at random - the exact flake.
    // This is not a hang mask: it is the right budget for integration tests. Attempts to shrink
    // the cold-start instead were dead ends - autoIndex:false breaks index-dependent suites, and
    // a single shared mongod serializes every worker's index builds and made it markedly worse.
    testTimeout: 30000,
    exclude: ['**/node_modules/**', 'e2e', '.next/**', '.open-next/**'],
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
