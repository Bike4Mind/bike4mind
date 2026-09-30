import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235958_ensure-fabfile-github-connection-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'githubConnectionId_1_deletedAt_1_status_1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle mongoose's own autoIndex build before the beforeEach drop, same race as the sibling
  // ensure-*-index tests: otherwise a background rebuild can land after the drop and the
  // "not there yet" assertion sees an index the migration did not build.
  await FabFile.init();
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
  await safeDropIndex(FabFile.collection, INDEX_NAME);
});

describe('ensure fabfile github connection index', () => {
  it('builds the index and is safe to re-run', async () => {
    expect((await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME)).toBeUndefined();

    await migration.up();
    await migration.up();

    const idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ githubConnectionId: 1, deletedAt: 1, status: 1 });
  });

  it('sorts below the fail-closed backfill that must stay the highest id', () => {
    expect(migration.id).toBeLessThan(20260922000001);
  });
});
