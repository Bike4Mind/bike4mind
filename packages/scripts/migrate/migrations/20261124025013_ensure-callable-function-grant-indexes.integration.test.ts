import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { CallableFunction } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20261124025013_ensure-callable-function-grant-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEXES = ['callablefn_grant_org_state', 'callablefn_grant_project', 'callablefn_grant_users'];

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

const builtIndexes = async () =>
  (await CallableFunction.collection.indexes()).filter(i => INDEXES.includes(i.name ?? ''));

describe('ensure-callable-function-grant-indexes migration (real DB)', () => {
  it('builds the three share lookups on a collection that has none, and runs again without error', async () => {
    await CallableFunction.collection.dropIndexes();
    expect(await builtIndexes()).toEqual([]);

    await migration.up();
    await migration.up();

    const built = await builtIndexes();
    expect(built.map(i => i.name).sort()).toEqual(INDEXES);
    expect(built.find(i => i.name === 'callablefn_grant_org_state')?.key).toEqual({
      'grants.organizationId': 1,
      state: 1,
    });
  });
});
