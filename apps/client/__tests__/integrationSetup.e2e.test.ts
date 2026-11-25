import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { AdminSettings } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Pins ../vitest.setup.integration.ts. Its caller check reads mongoose's file layout, so a mongoose
// upgrade that moves the automatic init() calls would bring back the full build on every connect
// with no failure anywhere else, only a slower leg.

let server: Awaited<ReturnType<typeof createMongoServer>>;

const collectionNames = async () => (await mongoose.connection.db!.listCollections().toArray()).map(c => c.name);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('integration lane setup: model init is on request only', () => {
  it('builds nothing on connect or on settle, though the whole model registry is loaded', async () => {
    expect(mongoose.modelNames().length).toBeGreaterThan(100);
    await settleAutoIndexBuilds(mongoose);
    expect(await collectionNames()).toEqual([]);
  });

  it('builds a model collection and its declared indexes on an explicit init()', async () => {
    await AdminSettings.init();

    expect(await collectionNames()).toEqual([AdminSettings.collection.collectionName]);
    const built = (await AdminSettings.collection.indexes()).map(index => index.key);
    for (const [key] of AdminSettings.schema.indexes()) expect(built).toContainEqual(key);
  });

  it('does not build twice on one connection', () => {
    expect(AdminSettings.init()).toBe(AdminSettings.init());
  });
});
