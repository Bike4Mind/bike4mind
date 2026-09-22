import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { DataLakeCorpusActionModel, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-*-index tests' guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260922000000_ensure-data-lake-corpus-action-indexes';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const LAKE_INDEX = 'lakeId_1_at_-1__id_-1';
const FINDING_INDEX = 'lakeId_1_findingId_1_at_-1__id_-1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle mongoose's own autoIndex build BEFORE any test drops an index - see the sibling
  // ensure-data-lake-finding-indexes test for why this ordering matters.
  await DataLakeCorpusActionModel.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.createCollection(DataLakeCorpusActionModel.collection.collectionName).catch(() => {});
  await DataLakeCorpusActionModel.collection.deleteMany({});
  await safeDropIndex(DataLakeCorpusActionModel.collection, LAKE_INDEX);
  await safeDropIndex(DataLakeCorpusActionModel.collection, FINDING_INDEX);
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a mocked
// collection cannot verify.
describe('ensure-data-lake-corpus-action-indexes migration (real DB)', () => {
  it('builds the lake-history index with an _id tiebreak on `at`', async () => {
    expect((await DataLakeCorpusActionModel.collection.indexes()).find(i => i.name === LAKE_INDEX)).toBeUndefined();

    await migration.up();

    const idx = (await DataLakeCorpusActionModel.collection.indexes()).find(i => i.name === LAKE_INDEX);
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ lakeId: 1, at: -1, _id: -1 });
  });

  it('builds the finding-scoped index, also tiebroken on _id', async () => {
    await migration.up();

    const idx = (await DataLakeCorpusActionModel.collection.indexes()).find(i => i.name === FINDING_INDEX);
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ lakeId: 1, findingId: 1, at: -1, _id: -1 });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    expect((await DataLakeCorpusActionModel.collection.indexes()).filter(i => i.name === LAKE_INDEX)).toHaveLength(1);
  });
});
