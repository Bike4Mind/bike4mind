import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Same guard as the sibling fabfile index migrations' tests.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235976_ensure-fabfile-derived-from-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'derivedFrom.fileId_1_deletedAt_1';

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

describe('ensure-fabfile-derived-from-index migration (real DB)', () => {
  it('builds the partial reverse-lineage index', async () => {
    let idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(Object.keys(idx!.key)).toEqual(['derivedFrom.fileId', 'deletedAt']);
    expect(idx?.partialFilterExpression).toEqual({ sourceType: 'tool_generated' });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });
});
