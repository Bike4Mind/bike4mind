import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Same guard as the sibling fabfile index migrations' tests.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235970_ensure-fabfile-owner-organization-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'organizationId_1_deletedAt_1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop indexes - see createMongoServer's autoIndex note.
  await FabFile.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.createCollection(FabFile.collection.collectionName).catch(() => {});
  await FabFile.collection.deleteMany({});
  await safeDropIndex(FabFile.collection, INDEX_NAME);
});

describe('ensure-fabfile-owner-organization-index migration (real DB)', () => {
  it('builds the partial org-owner index the org storage truth sums through', async () => {
    expect((await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME)).toBeUndefined();

    await migration.up();

    const idx = (await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(Object.keys(idx!.key)).toEqual(['organizationId', 'deletedAt']);
    // Partial, so personal rows (the large majority) carry no entry.
    expect(idx?.partialFilterExpression).toEqual({ organizationId: { $type: 'string' } });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    expect((await FabFile.collection.indexes()).find(i => i.name === INDEX_NAME)).toBeDefined();
  });
});
