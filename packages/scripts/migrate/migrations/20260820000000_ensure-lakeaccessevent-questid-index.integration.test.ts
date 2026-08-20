import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { LakeAccessEventModel, safeDropIndex } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-organization-member-index test's guard so this stays robust if
// that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260820000000_ensure-lakeaccessevent-questid-index';

const INDEX_NAME = 'questId_1';

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
  await mongoose.connection.db?.createCollection(LakeAccessEventModel.collection.collectionName).catch(() => {});
  await LakeAccessEventModel.collection.deleteMany({});
  // Ensure the index is absent before each test (autoIndex may have built it on connect).
  await safeDropIndex(LakeAccessEventModel.collection, INDEX_NAME);
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a
// mocked collection can't verify.
describe('ensure-lakeaccessevent-questid-index migration (real DB)', () => {
  it('builds the sparse questId index used to join an audit row back to its turn', async () => {
    let idx = (await LakeAccessEventModel.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await LakeAccessEventModel.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
    // sparse, not a plain index (fact 9 of the plan): most rows have no questId, and options
    // can't be changed after the fact without a coordinated drop-and-rebuild.
    expect(idx?.sparse).toBe(true);
  }, 30000);

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await LakeAccessEventModel.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  }, 30000);
});
