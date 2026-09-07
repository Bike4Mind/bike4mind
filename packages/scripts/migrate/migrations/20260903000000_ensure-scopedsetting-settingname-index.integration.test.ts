import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { ScopedSetting, safeDropIndex } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-lakeaccessevent-questid-index test's guard so this stays robust if
// that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260903000000_ensure-scopedsetting-settingname-index';

const INDEX_NAME = 'settingName_1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(async () => {
  // Ensure the collection exists before touching indexes on a fresh mongod - listIndexes/dropIndex
  // throw NamespaceNotFound against a collection that was never created, unlike deleteMany.
  await mongoose.connection.db?.createCollection(ScopedSetting.collection.collectionName).catch(() => {});
  await ScopedSetting.collection.deleteMany({});
  // Ensure the index is absent before each test (autoIndex may have built it on connect).
  await safeDropIndex(ScopedSetting.collection, INDEX_NAME);
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a mocked
// collection can't verify.
describe('ensure-scopedsetting-settingname-index migration (real DB)', () => {
  it('builds the by-setting index findBySettingName reads through', async () => {
    let idx = (await ScopedSetting.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await ScopedSetting.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ settingName: 1 });
  }, 30000);

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await ScopedSetting.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  }, 30000);
});
