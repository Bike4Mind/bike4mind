import { CreditHolderType } from '@bike4mind/common';
import {
  PendingCreditHoldModel,
  User,
  pendingCreditHoldRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import mongoose, { Types } from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { createCompletionCreditHolds, COMPLETION_CREDIT_HOLD_TTL_MS } from './completionCreditHolds';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryReplSet;
beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([User.createCollection(), PendingCreditHoldModel.createCollection()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([User.collection.deleteMany({}), PendingCreditHoldModel.collection.deleteMany({})]);
});

async function fixture() {
  const ownerId = new Types.ObjectId().toHexString();
  await User.collection.insertOne({ _id: new Types.ObjectId(ownerId), currentCredits: 100 });
  const lifecycle = createCompletionCreditHolds(new Logger({ metadata: { test: 'completion holds' } }));
  const balance = async () => (await User.collection.findOne({ _id: new Types.ObjectId(ownerId) }))?.currentCredits;
  const reserve = () =>
    lifecycle.reserve(
      { ownerId, ownerType: CreditHolderType.User, userId: ownerId, organizationId: null, reservedCredits: 30 },
      async () => {
        const user = await userRepository.incrementCredits(ownerId, -30);
        if (!user) throw new Error('User missing');
        return user;
      }
    );
  return { lifecycle, ownerId, balance, reserve };
}

describe('durable platform completion holds', () => {
  it('persists a crashed completion reservation so expiry can refund it exactly once', async () => {
    const { reserve, balance } = await fixture();
    await reserve(); // Simulated process death: no completion settlement or refund runs.
    expect(await balance()).toBe(70);
    const expired = await pendingCreditHoldRepository.findExpired(
      new Date(Date.now() + COMPLETION_CREDIT_HOLD_TTL_MS + 1_000),
      10
    );
    expect(expired).toHaveLength(1);
    const pending = expired[0]!;
    await withTransaction(async () => {
      const claimed = await pendingCreditHoldRepository.claim(pending.id);
      if (claimed) await userRepository.incrementCredits(claimed.ownerId, claimed.reservedCredits);
    });
    expect(await balance()).toBe(100);
    expect(await pendingCreditHoldRepository.claim(pending.id)).toBeNull();
  });

  it('settles the actual charge and retains a receipt without charging twice', async () => {
    const { lifecycle, reserve, balance, ownerId } = await fixture();
    await reserve();
    const settle = async () => {
      await userRepository.incrementCredits(ownerId, 20);
    };
    expect(await lifecycle.settle(10, settle)).toBe(true);
    expect(await lifecycle.settle(10, settle)).toBe(true);
    expect(await balance()).toBe(90);
    expect(
      await pendingCreditHoldRepository.findExpired(new Date(Date.now() + COMPLETION_CREDIT_HOLD_TTL_MS + 1_000), 10)
    ).toEqual([]);
  });

  it('rolls back the receipt and partial refund when settlement fails, leaving the original hold recoverable', async () => {
    const { lifecycle, reserve, balance, ownerId } = await fixture();
    await reserve();
    expect(
      await lifecycle.settle(10, async () => {
        await userRepository.incrementCredits(ownerId, 20);
        throw new Error('ledger unavailable');
      })
    ).toBe(false);
    expect(await balance()).toBe(70);
    expect(
      await pendingCreditHoldRepository.findExpired(new Date(Date.now() + COMPLETION_CREDIT_HOLD_TTL_MS + 1_000), 10)
    ).toHaveLength(1);
  });

  it('refunds provider failures once and prevents a later settlement', async () => {
    const { lifecycle, reserve, balance, ownerId } = await fixture();
    await reserve();
    const refund = async () => {
      await userRepository.incrementCredits(ownerId, 30);
    };
    expect(await lifecycle.refund(refund)).toBe(true);
    expect(await lifecycle.refund(refund)).toBe(false);
    expect(
      await lifecycle.settle(10, async () => {
        throw new Error('must not settle');
      })
    ).toBe(false);
    expect(await balance()).toBe(100);
  });

  it('rolls a failed reservation back before a provider can run', async () => {
    const { lifecycle, ownerId, balance } = await fixture();
    await expect(
      lifecycle.reserve(
        { ownerId, ownerType: CreditHolderType.User, userId: ownerId, organizationId: null, reservedCredits: 30 },
        async () => {
          await userRepository.incrementCredits(ownerId, -30);
          throw new Error('reservation failed');
        }
      )
    ).rejects.toThrow('reservation failed');
    expect(await balance()).toBe(100);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(0);
  });
  it('rolls the balance and record back when recording fails after its insert', async () => {
    const { reserve, balance } = await fixture();
    const record = pendingCreditHoldRepository.record.bind(pendingCreditHoldRepository);
    vi.spyOn(pendingCreditHoldRepository, 'record').mockImplementationOnce(async (...args) => {
      await record(...args);
      throw new Error('record acknowledgement failed');
    });
    await expect(reserve()).rejects.toThrow('record acknowledgement failed');
    expect(await balance()).toBe(100);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(0);
  });
});
