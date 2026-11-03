import { defineConfig } from 'vitest/config';
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
    // Raise the 15s shared floor to 30s for the CI "misc" shard. This package has a handful of
    // real-Mongo integration suites (createMongoServer/createMongoReplSet) that pay the same
    // per-worker cold-start (index builds on connect + first-collection creation) as the client
    // and data shards, so the 15s unit-test budget can flake their first write. Keep in sync with
    // apps/client/vitest.config.mts and packages/database/vitest.config.ts.
    testTimeout: 30000,
  },
});
