import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Quest, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921239600_ensure-quest-session-keyset-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'sessionId_timestamp_id';
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Quest.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await Quest.collection.deleteMany({});
  // Awaiting init above prevents autoIndex from recreating this behind the migration test.
  await safeDropIndex(Quest.collection, INDEX_NAME);
});

// The page-cost regression lives with the model (QuestModel.sessionKeysetIndex.test.ts); this only
// proves the migration builds the index production relies on.
describe('ensure quest session keyset index', () => {
  it('builds the keyset index and is idempotent', async () => {
    expect((await Quest.collection.indexes()).find(index => index.name === INDEX_NAME)).toBeUndefined();

    await migration.up();
    await migration.up();

    const matchingIndexes = (await Quest.collection.indexes()).filter(index => index.name === INDEX_NAME);
    expect(matchingIndexes).toHaveLength(1);
    expect(matchingIndexes[0].key).toEqual({ sessionId: 1, timestamp: 1, _id: 1 });
  });
});
