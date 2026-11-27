import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { CallableFunctionReview } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20261124050904_ensure-callable-function-review-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEXES = ['callablefnreview_function_user', 'callablefnreview_user'];

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await CallableFunctionReview.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const builtIndexes = async () =>
  (await CallableFunctionReview.collection.indexes()).filter(i => INDEXES.includes(i.name ?? ''));

describe('ensure-callable-function-review-indexes migration (real DB)', () => {
  it('builds the unique review index and the person lookup, and runs again without error', async () => {
    await CallableFunctionReview.collection.dropIndexes();
    expect(await builtIndexes()).toEqual([]);

    await migration.up();
    await migration.up();

    const built = await builtIndexes();
    expect(built.map(i => i.name).sort()).toEqual(INDEXES);
    const unique = built.find(i => i.name === 'callablefnreview_function_user');
    expect(unique?.key).toEqual({ functionId: 1, userId: 1 });
    expect(unique?.unique).toBe(true);
  });
});
