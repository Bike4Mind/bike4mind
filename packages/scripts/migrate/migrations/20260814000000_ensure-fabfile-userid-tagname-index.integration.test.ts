import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, safeDropIndex } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-organization-member-index test's guard so this stays robust if
// that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260814000000_ensure-fabfile-userid-tagname-index';

const INDEX_NAME = 'userId_1_tags.name_1_archivedAt_1_deletedAt_1';

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
  // Ensure the collection exists before touching indexes on a fresh mongod - listIndexes/
  // dropIndex throw NamespaceNotFound against a collection that was never created, unlike
  // deleteMany (mirrors 20260813000001_ensure-organization-member-index's own guard).
  await mongoose.connection.db?.createCollection(FabFile.collection.collectionName).catch(() => {});
  await FabFile.collection.deleteMany({});
  // Ensure the index is absent before each test (autoIndex may have built it on connect).
  await safeDropIndex(FabFile.collection, INDEX_NAME);
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a
// mocked collection can't verify.
describe('ensure-fabfile-userid-tagname-index migration (real DB)', () => {
  it('builds the userId/tags.name index used by the prefix-arm data-lake membership query', async () => {
    let idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  }, 30000);

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  }, 30000);
});
