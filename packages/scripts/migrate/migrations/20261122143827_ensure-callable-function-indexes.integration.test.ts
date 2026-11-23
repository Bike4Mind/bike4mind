import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { CallableFunction } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20261122143827_ensure-callable-function-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const UNIQUE_INDEXES = ['callablefn_owner_slug'];

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await CallableFunction.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const uniqueIndexes = async () =>
  (await CallableFunction.collection.indexes()).filter(i => UNIQUE_INDEXES.includes(i.name ?? ''));

describe('ensure-callable-function-indexes migration (real DB)', () => {
  it('builds the unique index on a collection that has none, and runs again without error', async () => {
    await CallableFunction.collection.dropIndexes();
    expect(await uniqueIndexes()).toEqual([]);

    await migration.up();
    await migration.up();

    const built = await uniqueIndexes();
    expect(built.map(i => i.name).sort()).toEqual([...UNIQUE_INDEXES].sort());
    for (const index of built) expect(index.unique).toBe(true);
    expect(built.find(i => i.name === 'callablefn_owner_slug')?.key).toEqual({ ownerType: 1, ownerKey: 1, slug: 1 });
  });
});
