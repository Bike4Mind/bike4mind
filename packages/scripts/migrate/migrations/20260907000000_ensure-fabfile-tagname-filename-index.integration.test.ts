import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Mirrors the sibling ensure-fabfile-userid-tagname-index test's guard: a core migration imported
// transitively via '@bike4mind/database' need not evaluate SST config, but this keeps it robust if
// that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260907000000_ensure-fabfile-tagname-filename-index';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'tags.name_1_fileName_1_deletedAt_1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  // listIndexes/dropIndex throw NamespaceNotFound against a collection that was never created on a
  // fresh mongod, unlike deleteMany - same guard as the sibling index migrations' tests.
  await mongoose.connection.db?.createCollection(FabFile.collection.collectionName).catch(() => {});
  await FabFile.collection.deleteMany({});
  // autoIndex may have built it on connect; the migration's job is to build it where it is absent.
  await safeDropIndex(FabFile.collection, INDEX_NAME);
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a mocked
// collection cannot verify.
describe('ensure-fabfile-tagname-filename-index migration (real DB)', () => {
  it('builds the tags.name/fileName index the admission sibling lookup reads through', async () => {
    let idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
    // Key ORDER is the point, not just presence: `fileName` after `tags.name` is what lets one
    // lake's tag bound the scan before the name equality applies.
    expect(idx?.key).toEqual({ 'tags.name': 1, fileName: 1, deletedAt: 1 });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });
});
