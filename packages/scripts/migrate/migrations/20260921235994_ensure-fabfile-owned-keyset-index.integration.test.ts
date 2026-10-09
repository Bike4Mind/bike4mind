import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Same guard as the sibling fabfile index migrations' tests.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235994_ensure-fabfile-owned-keyset-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'userId_1_deletedAt_1_archivedAt_1__id_1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop indexes - see createMongoServer's autoIndex note.
  await FabFile.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.createCollection(FabFile.collection.collectionName).catch(() => {});
  await FabFile.collection.deleteMany({});
  // autoIndex may have built it on connect; the migration's job is to build it where it is absent.
  await safeDropIndex(FabFile.collection, INDEX_NAME);
});

describe('ensure-fabfile-owned-keyset-index migration (real DB)', () => {
  it('builds the owned-files keyset index the public file list reads through', async () => {
    let idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    // Key ORDER is the point: the equality prefix, then `_id` last so a page streams in keyset order.
    // toEqual ignores key order, so pin it separately.
    expect(idx?.key).toEqual({ userId: 1, deletedAt: 1, archivedAt: 1, _id: 1 });
    expect(Object.keys(idx!.key)).toEqual(['userId', 'deletedAt', 'archivedAt', '_id']);
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });
});
