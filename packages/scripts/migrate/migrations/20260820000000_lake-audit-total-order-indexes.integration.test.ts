import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { LakeAccessEventModel, LakeConfigChangeEventModel } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260820000000_lake-audit-total-order-indexes';

const LEGACY = [
  { collection: () => LakeConfigChangeEventModel.collection, key: { dataLakeId: 1, createdAt: -1 } },
  { collection: () => LakeAccessEventModel.collection, key: { resolvedLakeIds: 1, createdAt: -1 } },
  { collection: () => LakeAccessEventModel.collection, key: { principalKind: 1, principalId: 1, createdAt: -1 } },
];

let server: Awaited<ReturnType<typeof createMongoServer>>;

const keys = async (collection: mongoose.Collection) => (await collection.indexes()).map(i => JSON.stringify(i.key));

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // `init()` IS the connect-time autoIndex promise for these two models. Awaiting it is what makes
  // the beforeEach below deterministic: otherwise that build is still in flight and can recreate
  // the very indexes beforeEach just dropped, so the pre-migration state under test is a race.
  await Promise.all([LakeConfigChangeEventModel.init(), LakeAccessEventModel.init()]);
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  // listIndexes/dropIndex throw NamespaceNotFound against a collection that was never created,
  // so create it explicitly on a fresh mongod (same guard as the sibling index migrations).
  for (const name of [LakeConfigChangeEventModel, LakeAccessEventModel].map(m => m.collection.collectionName)) {
    await mongoose.connection.db?.createCollection(name).catch(() => {});
  }
  // Reproduce a pre-migration environment: only the shorter indexes exist.
  for (const { collection, key } of LEGACY) {
    for (const index of await collection().indexes()) {
      if (index.name !== '_id_' && !index.expireAfterSeconds) {
        await collection()
          .dropIndex(index.name!)
          .catch(() => {});
      }
    }
    await collection().createIndex(key as never);
  }
}, 120000);

// Real mongod, not mocks: the migration is entirely index side effects, which a mocked collection
// cannot verify - and the drop is guarded on state read back from the engine.
describe('lake-audit-total-order-indexes migration (real DB)', () => {
  it('adds the _id tie-break and drops the shorter index it supersedes', async () => {
    await migration.up();

    expect(await keys(LakeConfigChangeEventModel.collection)).toContain(
      JSON.stringify({ dataLakeId: 1, createdAt: -1, _id: -1 })
    );
    const accessKeys = await keys(LakeAccessEventModel.collection);
    expect(accessKeys).toContain(JSON.stringify({ resolvedLakeIds: 1, createdAt: -1, _id: -1 }));
    expect(accessKeys).toContain(JSON.stringify({ principalKind: 1, principalId: 1, createdAt: -1, _id: -1 }));

    for (const { collection, key } of LEGACY) {
      expect(await keys(collection())).not.toContain(JSON.stringify(key));
    }
  }, 60000);

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    expect(await keys(LakeConfigChangeEventModel.collection)).toContain(
      JSON.stringify({ dataLakeId: 1, createdAt: -1, _id: -1 })
    );
  }, 60000);
});
