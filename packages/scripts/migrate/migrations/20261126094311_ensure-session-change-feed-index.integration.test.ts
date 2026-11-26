import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Session } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20261126094311_ensure-session-change-feed-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await Session.createCollection();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('session change feed index migration', () => {
  it('builds only the (userId, updatedAt, _id) index with automatic indexes disabled, idempotently', async () => {
    expect(await Session.collection.indexes()).toHaveLength(1);
    await migration.up();
    await migration.up();
    const indexes = await Session.collection.indexes();
    expect(indexes).toHaveLength(2);
    expect(indexes[1].key).toEqual({ userId: 1, updatedAt: 1, _id: 1 });
  });
});
