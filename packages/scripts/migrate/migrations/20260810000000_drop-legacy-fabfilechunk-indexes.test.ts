import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFileChunk } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

// At least one real core migration imports ../../utils/config, which evaluates SST Resource
// bindings at module load time and throws outside an SST-linked process - see index.test.ts.
// Importing './index' below (for AvailableMigrations) pulls that chain in transitively.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260810000000_drop-legacy-fabfilechunk-indexes';
import { AvailableMigrations } from './index';

// Real mongod, not mocks: safeDropIndex's swallow-on-not-found behavior and the index-name/
// key-pattern derivation this migration relies on are Mongo server behavior, not something a
// mock can stand in for.
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
  await mongoose.connection.db?.dropDatabase();
});

describe('drop-legacy-fabfilechunk-indexes migration (real DB)', () => {
  it('drops the two legacy indexes and keeps the keyset compound', async () => {
    await FabFileChunk.createIndexes();
    await FabFileChunk.collection.createIndex({ _id: 1, fabFileId: 1 });
    await FabFileChunk.collection.createIndex({ fabFileId: 1 });

    const before = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(before).toEqual(['_id_', '_id_1_fabFileId_1', 'fabFileId_1', 'fabFileId_1__id_1']);

    await migration.up();

    const after = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(after).toEqual(['_id_', 'fabFileId_1__id_1']);
  }, // Four real index builds plus two drops exceeded the 15s default under the shared "misc" CI
  // shard's load; real-world-validation.test.ts uses the same 30s bump for similarly-heavy cases.
  30000);

  it('refuses to drop when the keyset compound is missing', async () => {
    await FabFileChunk.collection.createIndex({ _id: 1, fabFileId: 1 });
    await FabFileChunk.collection.createIndex({ fabFileId: 1 });

    await expect(migration.up()).rejects.toThrow(/keyset compound is missing/);

    // Refused outright, not partially applied.
    const after = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(after).toEqual(['_id_', '_id_1_fabFileId_1', 'fabFileId_1']);
  });

  it('drops the legacy indexes even when the engine derived different names for them', async () => {
    // Guards against dropping by a hardcoded name: an engine that names these indexes
    // differently must not make the drop a silent, permanently-un-retried no-op.
    await FabFileChunk.createIndexes();
    await FabFileChunk.collection.createIndex({ _id: 1, fabFileId: 1 }, { name: 'legacy_compound_custom_name' });
    await FabFileChunk.collection.createIndex({ fabFileId: 1 }, { name: 'legacy_single_custom_name' });

    await migration.up();

    const after = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(after).toEqual(['_id_', 'fabFileId_1__id_1']);
  });

  it('refuses to drop when the keyset compound is hidden (present but unusable)', async () => {
    await FabFileChunk.collection.createIndex({ fabFileId: 1, _id: 1 }, { hidden: true });
    await FabFileChunk.collection.createIndex({ _id: 1, fabFileId: 1 });
    await FabFileChunk.collection.createIndex({ fabFileId: 1 });

    await expect(migration.up()).rejects.toThrow(/keyset compound is missing/);

    const after = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(after).toEqual(['_id_', '_id_1_fabFileId_1', 'fabFileId_1', 'fabFileId_1__id_1']);
  });

  it('refuses to drop when the keyset compound is narrowed by a partial filter', async () => {
    await FabFileChunk.collection.createIndex(
      { fabFileId: 1, _id: 1 },
      { partialFilterExpression: { fabFileId: { $exists: true } } }
    );
    await FabFileChunk.collection.createIndex({ _id: 1, fabFileId: 1 });
    await FabFileChunk.collection.createIndex({ fabFileId: 1 });

    await expect(migration.up()).rejects.toThrow(/keyset compound is missing/);

    const after = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(after).toEqual(['_id_', '_id_1_fabFileId_1', 'fabFileId_1', 'fabFileId_1__id_1']);
  });

  it('refuses to drop when the keyset compound has a non-default collation', async () => {
    await FabFileChunk.collection.createIndex({ fabFileId: 1, _id: 1 }, { collation: { locale: 'en', strength: 2 } });
    await FabFileChunk.collection.createIndex({ _id: 1, fabFileId: 1 });
    await FabFileChunk.collection.createIndex({ fabFileId: 1 });

    await expect(migration.up()).rejects.toThrow(/keyset compound is missing/);

    const after = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(after).toEqual(['_id_', '_id_1_fabFileId_1', 'fabFileId_1', 'fabFileId_1__id_1']);
  });

  it('no-ops when the fabfilechunks collection does not exist', async () => {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('no active MongoDB connection');
    }
    expect(await db.listCollections({ name: 'fabfilechunks' }).toArray()).toHaveLength(0);

    await expect(migration.up()).resolves.toBeUndefined();

    expect(await db.listCollections({ name: 'fabfilechunks' }).toArray()).toHaveLength(0);
  });

  it('is registered in AvailableMigrations', () => {
    const found = AvailableMigrations.find(m => m.id === migration.id);
    expect(found).toBe(migration);
  });
});
