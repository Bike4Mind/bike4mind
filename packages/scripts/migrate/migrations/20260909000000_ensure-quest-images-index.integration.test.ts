import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Quest, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-*-index tests' guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260909000000_ensure-quest-images-index';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'images';

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
describe('ensure-quest-images-index migration (real DB)', () => {
  it('builds the multikey images index the generated-image authz lookup matches on', async () => {
    let idx = (await Quest.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await Quest.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ images: 1 });
    // Sparse keeps the index off the quests that carry no images (most of them).
    expect(idx?.sparse).toBe(true);
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await Quest.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });
});
