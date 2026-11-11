import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921241030_backfill-provider-end-user-id';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>> | undefined;
const users = () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection not established');
  return db.collection('users');
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await users().deleteMany({});
});

describe('backfill provider end user id', () => {
  it('hashes every user id once, keeps existing values and builds the lookup index', async () => {
    const ids = Array.from({ length: 3 }, () => new Types.ObjectId());
    const kept = new Types.ObjectId();
    await users().insertMany([
      ...ids.map((_id, i) => ({ _id, username: `user${i}` })),
      { _id: kept, username: 'kept', providerEndUserId: 'existing' },
    ]);

    await migration.up();
    await migration.up();

    for (const _id of ids) {
      expect((await users().findOne({ _id }))?.providerEndUserId).toBe(toProviderEndUserId(String(_id)));
    }
    expect((await users().findOne({ _id: kept }))?.providerEndUserId).toBe('existing');
    const indexes = await users().indexes();
    expect(indexes.find(index => index.name === 'user_providerEndUserId')).toMatchObject({
      key: { providerEndUserId: 1 },
      sparse: true,
    });
  });
});
