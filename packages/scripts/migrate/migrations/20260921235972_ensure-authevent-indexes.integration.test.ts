import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { AUTH_EVENT_RETENTION_SECONDS, AuthEventModel, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Same guard as the sibling index migrations' tests.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235972_ensure-authevent-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const TTL_INDEX = 'createdAt_1';
const USER_INDEX = 'userId_1_createdAt_-1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop indexes - see createMongoServer's autoIndex note.
  await AuthEventModel.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.createCollection(AuthEventModel.collection.collectionName).catch(() => {});
  await safeDropIndex(AuthEventModel.collection, TTL_INDEX);
  await safeDropIndex(AuthEventModel.collection, USER_INDEX);
});

describe('ensure-authevent-indexes migration (real DB)', () => {
  it('builds the 90-day TTL that bounds how long raw signup/login IPs are kept', async () => {
    expect((await AuthEventModel.collection.indexes()).find(i => i.name === TTL_INDEX)).toBeUndefined();

    await migration.up();

    const ttl = (await AuthEventModel.collection.indexes()).find(i => i.name === TTL_INDEX);
    expect(ttl?.key).toEqual({ createdAt: 1 });
    expect(ttl?.expireAfterSeconds).toBe(AUTH_EVENT_RETENTION_SECONDS);
    expect(AUTH_EVENT_RETENTION_SECONDS).toBe(90 * 24 * 60 * 60);
  });

  it('builds the per-user read index', async () => {
    await migration.up();

    const idx = (await AuthEventModel.collection.indexes()).find(i => i.name === USER_INDEX);
    expect(idx?.key).toEqual({ userId: 1, createdAt: -1 });
  });
});
