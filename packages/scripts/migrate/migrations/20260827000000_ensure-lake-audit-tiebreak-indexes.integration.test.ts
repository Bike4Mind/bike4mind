import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { LakeAccessEventModel, LakeConfigChangeEventModel, safeDropIndex } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

// Mirrors the sibling ensure-lakeaccessevent-questid-index test's guard: a core migration imported
// transitively via '@bike4mind/database' need not evaluate SST config, but stay robust if it does.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260827000000_ensure-lake-audit-tiebreak-indexes';

const key = (k: Record<string, number>) => JSON.stringify(k);

const LEGACY = {
  config: { dataLakeId: 1, createdAt: -1 },
  byLake: { resolvedLakeIds: 1, createdAt: -1 },
};
const REPLACEMENT = {
  config: { dataLakeId: 1, createdAt: -1, _id: -1 },
  byLake: { resolvedLakeIds: 1, createdAt: -1, _id: -1 },
};

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
  for (const model of [LakeAccessEventModel, LakeConfigChangeEventModel]) {
    // listIndexes/dropIndex throw NamespaceNotFound on a collection that was never created.
    await mongoose.connection.db?.createCollection(model.collection.collectionName).catch(() => {});
    await model.collection.deleteMany({});
    for (const index of await model.collection.indexes()) {
      if (index.name && index.name !== '_id_') await safeDropIndex(model.collection, index.name);
    }
  }
});

// Real mongod, not mocks: the migration is entirely index side effects, which mocks can't verify.
describe('ensure-lake-audit-tiebreak-indexes migration (real DB)', () => {
  it('builds the _id-suffixed listByLake indexes and drops the two-key versions they supersede', async () => {
    // Stand up the pre-migration state: the superseded definitions, as deployed today.
    await LakeConfigChangeEventModel.collection.createIndex(LEGACY.config);
    await LakeAccessEventModel.collection.createIndex(LEGACY.byLake);

    await migration.up();

    const configKeys = (await LakeConfigChangeEventModel.collection.indexes()).map(i => key(i.key as never));
    const accessKeys = (await LakeAccessEventModel.collection.indexes()).map(i => key(i.key as never));

    expect(configKeys).toContain(key(REPLACEMENT.config));
    expect(configKeys).not.toContain(key(LEGACY.config));
    expect(accessKeys).toContain(key(REPLACEMENT.byLake));
    expect(accessKeys).not.toContain(key(LEGACY.byLake));
    // listByPrincipal keeps its plain { createdAt: -1 } sort, so its index is left untouched.
    expect(accessKeys).toContain(key({ principalKind: 1, principalId: 1, createdAt: -1 }));
  }, 60000);

  it('refuses to drop a legacy index when its replacement was not built, leaving the read covered', async () => {
    await LakeConfigChangeEventModel.collection.createIndex(LEGACY.config);
    // Suppress the index build so `up()` reaches the drop loop with the replacement missing - the
    // shape a failed or partial createIndexes leaves behind, and the only thing the guard exists
    // for. Nothing else in the migration can produce it.
    const configBuild = vi.spyOn(LakeConfigChangeEventModel, 'createIndexes').mockResolvedValue(undefined);
    const accessBuild = vi.spyOn(LakeAccessEventModel, 'createIndexes').mockResolvedValue(undefined);

    try {
      await expect(migration.up()).rejects.toThrow(/Refusing to drop/);
      const configKeys = (await LakeConfigChangeEventModel.collection.indexes()).map(i => key(i.key as never));
      expect(configKeys).toContain(key(LEGACY.config));
    } finally {
      configBuild.mockRestore();
      accessBuild.mockRestore();
    }
  }, 60000);

  it('is idempotent on re-run and on an environment that never had the legacy indexes', async () => {
    await migration.up();
    await migration.up();

    const configKeys = (await LakeConfigChangeEventModel.collection.indexes()).map(i => key(i.key as never));
    const accessKeys = (await LakeAccessEventModel.collection.indexes()).map(i => key(i.key as never));
    expect(configKeys).toContain(key(REPLACEMENT.config));
    expect(accessKeys).toContain(key(REPLACEMENT.byLake));
  }, 60000);
});
