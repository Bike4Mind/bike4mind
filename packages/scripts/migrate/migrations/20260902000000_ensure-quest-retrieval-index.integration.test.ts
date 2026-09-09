import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Quest, safeDropIndex } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-*-index tests' guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260902000000_ensure-quest-retrieval-index';

const INDEX_NAME = 'retrieval_timestamp_desc';

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
  // fresh mongod, unlike deleteMany (mirrors the sibling ensure-*-index tests' own guard).
  await mongoose.connection.db?.createCollection(Quest.collection.collectionName).catch(() => {});
  await Quest.collection.deleteMany({});
  // Ensure the index is absent before each test (autoIndex may have built it on connect).
  await safeDropIndex(Quest.collection, INDEX_NAME);
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a
// mocked collection can't verify.
describe('ensure-quest-retrieval-index migration (real DB)', () => {
  it('builds the partial index the retrieval-rate endpoint sorts on', async () => {
    let idx = (await Quest.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await Quest.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
    // Descending matches the endpoint's sort, so the limit walks the index rather than
    // blocking-sorting; reversed, the scan ceiling would bound returned rows only.
    expect(idx?.key).toEqual({ timestamp: -1 });
    // The partial filter is what makes the index usable for the endpoint's own predicate and
    // keeps it off the turns that could never have retrieved.
    expect(idx?.partialFilterExpression).toEqual({ 'promptMeta.retrieval': { $exists: true } });
  }, 30000);

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await Quest.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  }, 30000);
});
