import { createMongoServer } from './src/__test__/createMongoServer';

/**
 * Global setup for the database package's Vitest suite: download and cache the
 * MongoDB binary before any tests run, so parallel test files don't race to
 * download it simultaneously.
 */
export async function setup() {
  // Create a temporary instance to trigger binary download. Routed through
  // createMongoServer() so this spawn site shares the port-collision retry
  // with the suites - keeping every mongod spawn in the package consistent.
  const instance = await createMongoServer();
  // Stop it immediately - we just needed to ensure the binary is cached
  await instance.stop();
}
