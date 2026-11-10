import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { UsageEvent, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Mirror the sibling ensure-*-index tests' guard against SST config evaluation.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921240070_ensure-usage-event-feature-status-index';

// Boots a real mongod (see MONGO_TEST_TIMEOUT_MS for why the default budget is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'feature_1_status_1_createdAt_-1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop indexes - see createMongoServer's autoIndex note.
  await UsageEvent.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  // listIndexes/dropIndex throw NamespaceNotFound against a never-created collection.
  await mongoose.connection.db?.createCollection(UsageEvent.collection.collectionName).catch(() => {});
  await UsageEvent.collection.deleteMany({});
  await safeDropIndex(UsageEvent.collection, INDEX_NAME);
});

// Real mongod, not mocks: the migration's whole job is an index-build side effect.
describe('ensure-usage-event-feature-status-index migration (real DB)', () => {
  it('builds the index the hourly completion sweeps filter on', async () => {
    expect((await UsageEvent.collection.indexes()).find(i => i.name === INDEX_NAME)).toBeUndefined();

    await migration.up();

    const idx = (await UsageEvent.collection.indexes()).find(i => i.name === INDEX_NAME);
    // Equality fields first, then the range field, so the sweeps' 24h window walks the index.
    expect(idx?.key).toEqual({ feature: 1, status: 1, createdAt: -1 });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const matches = (await UsageEvent.collection.indexes()).filter(i => i.name === INDEX_NAME);
    expect(matches).toHaveLength(1);
  });
});
