import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTest,
    // Download MongoDB binary once before all tests to prevent race conditions
    globalSetup: './vitest.setup.ts',
    // Increase timeout to allow for MongoDB binary download and operations
    hookTimeout: 60000,
    // Raise the 15s shared floor to 30s for the CI "data" shard. This package holds ~54 real-Mongo
    // integration suites (createMongoServer/createMongoReplSet) - the most of any shard - and each
    // worker's first write pays the same unavoidable cold-start apps/client does: Mongoose builds
    // every model's indexes on connect (correctness-required, autoIndex CANNOT be disabled) plus
    // first-collection creation. 15s is a unit-test budget; keep this in sync with the client
    // shard's override in apps/client/vitest.config.mts.
    testTimeout: 30000,
  },
});
