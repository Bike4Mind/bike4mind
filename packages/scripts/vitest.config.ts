import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';
import { sharedTest } from '../../vitest.shared';

const client = path.resolve(__dirname, '../../apps/client');

export default defineConfig({
  resolve: {
    // Lets the backfill scripts reuse apps/client/server code the way apps/workers does.
    alias: { '@server': path.join(client, 'server'), '@client': client },
  },
  test: {
    ...sharedTest,
    ...(process.env.REPO_TEST_LANE === 'repo'
      ? { include: ['**/*.repo.test.ts'] }
      : { exclude: [...configDefaults.exclude, '**/*.repo.test.ts'] }),
    // Raise the 15s shared floor to 30s for the CI "scripts" shard. This package has a handful of
    // real-Mongo integration suites (createMongoServer/createMongoReplSet) that pay a per-worker
    // mongod cold start plus whatever collections and indexes they build (vitest.setup.ts turns
    // the on-connect build off, so only explicit Model.init() calls pay for indexes), so the 15s
    // unit-test budget can flake their first write. Keep in sync with
    // apps/client/vitest.config.mts and packages/database/vitest.config.ts.
    testTimeout: 30000,
    setupFiles: ['./vitest.setup.ts'],
  },
});
