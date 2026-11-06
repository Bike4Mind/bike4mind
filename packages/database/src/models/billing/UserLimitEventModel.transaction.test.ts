import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import { createMongoReplSet, MONGO_TEST_TIMEOUT_MS, settleAutoIndexBuilds } from '../../__test__/createMongoServer';
import { UserLimitEventModel, userLimitEventRepository } from './UserLimitEventModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// A standalone mongod cannot run transactions, so only a replica set shows whether the write escapes one.
let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await UserLimitEventModel.createCollection();
  await UserLimitEventModel.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('userLimitEventRepository.record inside a refused hold', () => {
  it('keeps the row when the transaction it was recorded from aborts', async () => {
    const refusal = new Error('insufficient credits');
    await expect(
      withTransaction(async () => {
        await userLimitEventRepository.record({ userId: 'u-tx', kind: 'insufficient_credits' });
        throw refusal;
      })
    ).rejects.toBe(refusal);

    const rows = await UserLimitEventModel.find({ userId: 'u-tx' }).lean();
    expect(rows).toEqual([expect.objectContaining({ kind: 'insufficient_credits', count: 1 })]);
  });
});
