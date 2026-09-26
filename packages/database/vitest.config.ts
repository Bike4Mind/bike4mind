import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTest,
    // Download MongoDB binary once before all tests to prevent race conditions
    globalSetup: './vitest.setup.ts',
    // Increase timeout to allow for MongoDB binary download and operations
    hookTimeout: 60000,
    // Most suites here boot a real mongod (createMongoServer/createMongoReplSet/setupMongoTest), so
    // the package default IS the real-Mongo budget rather than a per-file declaration. Keep in sync
    // with MONGO_TEST_TIMEOUT_MS in src/__test__/createMongoServer.ts, which explains the 60s.
    testTimeout: 60000,
  },
});
