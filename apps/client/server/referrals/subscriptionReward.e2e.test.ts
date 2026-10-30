import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  CreditTransaction,
  ReferralSubscriptionRewardModel,
  User,
  creditLotRepository,
  referralSubscriptionRewardRepository,
} from '@bike4mind/database';
import { releaseDueSubscriptionRewards, reverseSubscriptionRewardForRefund } from './subscriptionReward';

const grantFailure = vi.hoisted(() => ({ next: false }));

// Wraps the real grant so one call can fail after the claim has been written inside the transaction.
vi.mock('@bike4mind/services', async importActual => {
  const actual = await importActual<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    creditService: {
      ...actual.creditService,
      addCreditsWithLedgerRow: (...args: Parameters<typeof actual.creditService.addCreditsWithLedgerRow>) => {
        if (grantFailure.next) {
          grantFailure.next = false;
          throw new Error('grant failed');
        }
        return actual.creditService.addCreditsWithLedgerRow(...args);
      },
    },
  };
});
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn() }));
vi.mock('./firstAnswerReward', async importActual => ({
  ...(await importActual<typeof import('./firstAnswerReward')>()),
  alertIfRewardsSpike: vi.fn(),
}));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The release claims the reward row and grants the credits inside one real transaction: both commit or
// neither does, so a failed grant leaves the reward pending and a repeat run never pays twice.

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

// dropDatabase removes the indexes the dedupe relies on.
beforeEach(async () => {
  await Promise.all([CreditTransaction.createIndexes(), ReferralSubscriptionRewardModel.createIndexes()]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});

const NOW = new Date('2026-11-20T00:00:00.000Z');
const REWARD_CREDITS = 6000;

const newUser = (name: string, currentCredits = 0) =>
  User.create({
    name,
    username: `${name}-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    currentCredits,
  });

async function seedDueReward() {
  const inviter = await newUser('inviter');
  const payer = await newUser('friend');
  await referralSubscriptionRewardRepository.create(
    {
      invoiceId: 'in_1',
      paymentIntentId: 'pi_1',
      payerId: payer.id,
      inviterId: inviter.id,
      step: 'first_payment',
      credits: REWARD_CREDITS,
      releaseAt: new Date(NOW.getTime() - 60_000),
    },
    NOW
  );
  return inviter;
}

describe('releaseDueSubscriptionRewards against a real replica set', () => {
  it('claims the reward and credits the inviter together', async () => {
    const inviter = await seedDueReward();

    const result = await releaseDueSubscriptionRewards({ now: NOW });

    expect(result).toMatchObject({ candidates: 1, released: 1, failed: 0 });
    expect((await User.findById(inviter.id))?.currentCredits).toBe(REWARD_CREDITS);
    expect(await referralSubscriptionRewardRepository.findByInvoiceId('in_1')).toMatchObject({ status: 'released' });
  });

  it('rolls the claim back when the grant fails, then pays once on the next run', async () => {
    const inviter = await seedDueReward();
    grantFailure.next = true;

    const failedRun = await releaseDueSubscriptionRewards({ now: NOW });

    expect(failedRun).toMatchObject({ released: 0, failed: 1 });
    expect(await referralSubscriptionRewardRepository.findByInvoiceId('in_1')).toMatchObject({ status: 'pending' });
    expect((await User.findById(inviter.id))?.currentCredits).toBe(0);

    expect(await releaseDueSubscriptionRewards({ now: NOW })).toMatchObject({ released: 1, failed: 0 });
    expect(await releaseDueSubscriptionRewards({ now: NOW })).toMatchObject({ candidates: 0, released: 0 });
    expect((await User.findById(inviter.id))?.currentCredits).toBe(REWARD_CREDITS);
    expect(await CreditTransaction.countDocuments({ ownerId: inviter.id })).toBe(1);
  });

  describe('take-back after release', () => {
    const lotOf = async (inviterId: string) => (await creditLotRepository.findByOwner(inviterId, 'User' as never))[0];
    const refundAll = () =>
      reverseSubscriptionRewardForRefund({
        paymentIntentId: 'pi_1',
        amountRefunded: 3000,
        amountCaptured: 3000,
        now: NOW,
      });

    it('shrinks the reward lot together with the balance', async () => {
      const inviter = await seedDueReward();
      await releaseDueSubscriptionRewards({ now: NOW });
      expect(await lotOf(inviter.id)).toMatchObject({ amount: REWARD_CREDITS });

      await refundAll();

      expect((await User.findById(inviter.id))?.currentCredits).toBe(0);
      expect(await lotOf(inviter.id)).toMatchObject({ amount: 0 });
    });

    it('never shrinks the lot below what was already spent from it', async () => {
      const inviter = await seedDueReward();
      await releaseDueSubscriptionRewards({ now: NOW });
      const lot = await lotOf(inviter.id);
      await creditLotRepository.update({ id: lot.id, consumedAssigned: 2000 });
      await User.updateOne({ _id: inviter.id }, { currentCredits: REWARD_CREDITS - 2000 });

      await refundAll();

      expect((await User.findById(inviter.id))?.currentCredits).toBe(0);
      expect(await lotOf(inviter.id)).toMatchObject({ amount: 2000, consumedAssigned: 2000 });
    });
  });
});
