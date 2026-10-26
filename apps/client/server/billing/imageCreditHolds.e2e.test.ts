import { getQuestErrorCode } from '@bike4mind/common';
import {
  CreditTransaction,
  Organization,
  PendingCreditHoldModel,
  pendingCreditHoldRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import mongoose, { Types } from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { imageCreditHolds } from './imageCreditHolds';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryReplSet;
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
const context = { featureLabel: 'image generation', logger };
const entry = { type: 'image_generation_usage', sessionId: 'session1', questId: 'quest1', model: 'test' } as const;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([
    User.createCollection(),
    Organization.createCollection(),
    PendingCreditHoldModel.createCollection(),
    CreditTransaction.createCollection(),
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all([
    User.collection.deleteMany({}),
    Organization.collection.deleteMany({}),
    PendingCreditHoldModel.collection.deleteMany({}),
    CreditTransaction.collection.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

async function userWith(currentCredits: number) {
  const id = new Types.ObjectId();
  await User.collection.insertOne({ _id: id, currentCredits });
  return {
    userId: id.toHexString(),
    balance: async () => (await User.collection.findOne({ _id: id }))?.currentCredits,
  };
}

describe('image credit holds against a replica set', () => {
  it('rolls back the debit when recording the pending hold fails', async () => {
    const { userId, balance } = await userWith(100);
    vi.spyOn(pendingCreditHoldRepository, 'record').mockRejectedValueOnce(new Error('record failed'));

    await expect(
      imageCreditHolds.hold({ userId, organizationId: null, requiredCredits: 40, ...context })
    ).rejects.toThrow('record failed');

    expect(await balance()).toBe(100);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(0);
    expect(await CreditTransaction.countDocuments()).toBe(0);
  });

  it('leaves the pending hold refundable when release fails without throwing', async () => {
    const { userId, balance } = await userWith(100);
    const hold = await imageCreditHolds.hold({ userId, organizationId: null, requiredCredits: 40, ...context });
    const release = vi.spyOn(userRepository, 'incrementCredits').mockRejectedValueOnce(new Error('refund failed'));

    await expect(imageCreditHolds.release(hold, context)).resolves.toBeUndefined();

    expect(await balance()).toBe(60);
    expect(await PendingCreditHoldModel.findById(hold.pendingHoldId)).not.toBeNull();
    expect(await CreditTransaction.countDocuments()).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('left for the expired-hold sweep'),
      expect.objectContaining({ holdId: hold.pendingHoldId, error: 'refund failed' })
    );

    release.mockRestore();
    await imageCreditHolds.release(hold, context);
    expect(await balance()).toBe(100);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(0);
  });

  it('lets exactly one of N concurrent holds through when the balance covers one', async () => {
    const { userId, balance } = await userWith(40);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        imageCreditHolds.hold({ userId, organizationId: null, requiredCredits: 40, ...context })
      )
    );

    const refused = results.filter(r => r.status === 'rejected');
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      expect(getQuestErrorCode((r as PromiseRejectedResult).reason)).toBe('insufficient_credits');
    }
    expect(await balance()).toBe(0);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(1);
  });

  it('release refunds the whole hold and claims its pending row', async () => {
    const { userId, balance } = await userWith(100);
    const hold = await imageCreditHolds.hold({ userId, organizationId: null, requiredCredits: 40, ...context });
    expect(await balance()).toBe(60);

    await imageCreditHolds.release(hold, context);

    expect(await balance()).toBe(100);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(0);
    expect(await CreditTransaction.countDocuments()).toBe(0);
  });

  it('settle keeps the draw, refunds the rest, writes the ledger row, and a later release is a no-op', async () => {
    const { userId, balance } = await userWith(100);
    const hold = await imageCreditHolds.hold({ userId, organizationId: null, requiredCredits: 40, ...context });

    const charged = await imageCreditHolds.settle(hold, 37, entry, context);
    await imageCreditHolds.release(hold, context);

    expect(charged).toBe(37);
    expect(await balance()).toBe(63);
    expect(await CreditTransaction.countDocuments({ type: 'image_generation_usage' })).toBe(1);
  });
});
