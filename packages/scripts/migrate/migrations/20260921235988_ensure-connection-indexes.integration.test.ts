import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Connection, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235988_ensure-connection-indexes';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget (see MONGO_TEST_TIMEOUT_MS).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAMES = ['userId_1', 'sid_1', 'apiKeyId_1'];

let server: Awaited<ReturnType<typeof createMongoServer>>;

const indexNames = async () => (await Connection.collection.indexes()).map(index => index.name);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop indexes - see createMongoServer's autoIndex note.
  await Connection.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  // listIndexes/dropIndex throw NamespaceNotFound against a collection that was never created.
  await mongoose.connection.db?.createCollection(Connection.collection.collectionName).catch(() => {});
  for (const name of INDEX_NAMES) await safeDropIndex(Connection.collection, name);
});

describe('ensure-connection-indexes migration (real DB)', () => {
  it('builds the userId, sid and apiKeyId indexes the revoke filters query by', async () => {
    expect(await indexNames()).not.toEqual(expect.arrayContaining(INDEX_NAMES));

    await migration.up();

    const indexes = await Connection.collection.indexes();
    for (const name of INDEX_NAMES) {
      expect(indexes.find(index => index.name === name)).toBeDefined();
    }
    expect(indexes.find(index => index.name === 'userId_1')?.key).toEqual({ userId: 1 });
    expect(indexes.find(index => index.name === 'sid_1')?.key).toEqual({ sid: 1 });
    expect(indexes.find(index => index.name === 'apiKeyId_1')?.key).toEqual({ apiKeyId: 1 });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    const first = await indexNames();

    await migration.up();

    expect((await indexNames()).sort()).toEqual(first.sort());
  });
});
