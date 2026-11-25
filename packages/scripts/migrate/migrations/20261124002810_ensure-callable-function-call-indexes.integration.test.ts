import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { CallableFunctionCall } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20261124002810_ensure-callable-function-call-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEXES = ['callablefncall_caller_started', 'callablefncall_function_started', 'callablefncall_ttl'];

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await CallableFunctionCall.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const builtIndexes = async () =>
  (await CallableFunctionCall.collection.indexes()).filter(i => INDEXES.includes(i.name ?? ''));

describe('ensure-callable-function-call-indexes migration (real DB)', () => {
  it('builds the lookups and the expiry on a collection that has none, and runs again without error', async () => {
    await CallableFunctionCall.collection.dropIndexes();
    expect(await builtIndexes()).toEqual([]);

    await migration.up();
    await migration.up();

    const built = await builtIndexes();
    expect(built.map(i => i.name).sort()).toEqual(INDEXES);
    expect(built.find(i => i.name === 'callablefncall_ttl')?.expireAfterSeconds).toBe(7776000);
  });
});
