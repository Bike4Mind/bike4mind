import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  AdminSettings,
  CreditTransaction,
  HeldCreditRewardModel,
  ReferralSubscriptionRewardModel,
  SignupGrantBudgetDayModel,
  User,
  creditLotRepository,
  heldCreditRewardRepository,
  referralSubscriptionRewardRepository,
  userRepository,
} from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import { buildCreditRewardAdapters } from '../credits/creditRewardAdapters';
import { releaseDueSubscriptionRewards, reverseSubscriptionRewardForRefund } from './subscriptionReward';

vi.mock('../integrations/stripe/stripe', () => ({ getStripe: vi.fn() }));
vi.mock('../integrations/slack/slack', () => ({
  postMessageToSlack: vi.fn(),
  postMessageToSlackWithOutcome: vi.fn(async () => ({ ok: true })),
}));
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

const TRICKLE_POOL = 'signupGrantTricklePoolDaily';
const setTricklePool = (credits: number) =>
  AdminSettings.updateOne({ settingName: TRICKLE_POOL }, { settingValue: String(credits) });

// dropDatabase removes the indexes the dedupe relies on.
beforeEach(async () => {
  await Promise.all([
    CreditTransaction.createIndexes(),
    ReferralSubscriptionRewardModel.createIndexes(),
    HeldCreditRewardModel.createIndexes(),
    SignupGrantBudgetDayModel.createIndexes(),
  ]);
  // Payouts draw from the trickle pool; an unset pool would queue every reward.
  await AdminSettings.create({ settingName: TRICKLE_POOL, settingValue: '1000000' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});

const NOW = new Date('2026-11-20T00:00:00.000Z');
const TTL_MS = creditService.REFERRAL_SUBSCRIPTION_REWARD_TTL_DAYS * 24 * 60 * 60 * 1000;
const REWARD_CREDITS = 6000;
const stillPaid = async () => 'paid' as const;

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
  return seedRewardFor(inviter, payer);
}

async function seedRewardFor(inviter: { id: string }, payer: { id: string }) {
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

    const result = await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid });

    expect(result).toMatchObject({ candidates: 1, released: 1, failed: 0 });
    expect((await User.findById(inviter.id))?.currentCredits).toBe(REWARD_CREDITS);
    expect(await referralSubscriptionRewardRepository.findByInvoiceId('in_1')).toMatchObject({ status: 'released' });
  });

  it('pays the reward into a promo lot that expires after 90 days', async () => {
    const inviter = await seedDueReward();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const before = Date.now();

    await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid });

    const [lot] = await creditLotRepository.findByOwner(inviter.id, 'User' as never);
    expect(lot).toMatchObject({ amount: REWARD_CREDITS, source: 'promo' });
    expect(lot.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ninetyDaysMs);
    expect(lot.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + ninetyDaysMs);
  });

  it('rolls the claim back when the grant fails, then pays once on the next run', async () => {
    const inviter = await seedDueReward();
    const incrementCredits = vi
      .spyOn(userRepository, 'incrementCredits')
      .mockRejectedValueOnce(new Error('grant failed'));

    const failedRun = await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid });

    expect(failedRun).toMatchObject({ released: 0, failed: 1 });
    expect(incrementCredits).toHaveBeenCalledOnce();
    expect(await referralSubscriptionRewardRepository.findByInvoiceId('in_1')).toMatchObject({ status: 'pending' });
    expect((await User.findById(inviter.id))?.currentCredits).toBe(0);
    expect(await CreditTransaction.countDocuments({ ownerId: inviter.id })).toBe(0);
    expect(await SignupGrantBudgetDayModel.findOne().lean()).toMatchObject({ spent: 0, reservedIds: [] });

    expect(await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid })).toMatchObject({
      released: 1,
      failed: 0,
    });
    expect(await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid })).toMatchObject({
      candidates: 0,
      released: 0,
    });
    expect((await User.findById(inviter.id))?.currentCredits).toBe(REWARD_CREDITS);
    expect(await CreditTransaction.countDocuments({ ownerId: inviter.id })).toBe(1);
  });

  it('expires an unpaid reward at its deadline without freeing the payment step', async () => {
    const inviter = await seedDueReward();
    const releaseAt = new Date(NOW.getTime() - TTL_MS);
    await ReferralSubscriptionRewardModel.updateOne({ invoiceId: 'in_1' }, { $set: { releaseAt } });
    const paymentOutcome = vi.fn(stillPaid);

    expect(await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome })).toMatchObject({
      cancelled: 1,
      released: 0,
      failed: 0,
    });
    const reward = await referralSubscriptionRewardRepository.findByInvoiceId('in_1');
    expect(reward).toMatchObject({ status: 'cancelled', closeReason: 'expired' });
    expect(await referralSubscriptionRewardRepository.findClaimedSteps(reward!.payerId)).toEqual(['first_payment']);
    expect((await User.findById(inviter.id))?.currentCredits).toBe(0);
    expect(await CreditTransaction.countDocuments()).toBe(0);
    expect(paymentOutcome).not.toHaveBeenCalled();
  });

  it('still releases a pending reward 1ms before its deadline', async () => {
    const inviter = await seedDueReward();
    const releaseAt = new Date(NOW.getTime() - TTL_MS + 1);
    await ReferralSubscriptionRewardModel.updateOne({ invoiceId: 'in_1' }, { $set: { releaseAt } });

    expect(await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid })).toMatchObject({
      released: 1,
      cancelled: 0,
      failed: 0,
    });
    expect((await User.findById(inviter.id))?.currentCredits).toBe(REWARD_CREDITS);
  });

  it.each([creditService.REFERRAL_SUBSCRIPTION_REWARD_TTL_DAYS, 365])(
    'keeps the full queued reward window after a %i-day hold',
    async holdDays => {
      const inviter = await seedDueReward();
      const createdAt = new Date(NOW.getTime() - holdDays * 24 * 60 * 60 * 1000);
      await ReferralSubscriptionRewardModel.collection.updateOne(
        { invoiceId: 'in_1' },
        { $set: { createdAt, releaseAt: NOW } }
      );
      await setTricklePool(0);

      expect(await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid })).toMatchObject({
        released: 1,
        cancelled: 0,
        failed: 0,
      });
      const transactionId = `referral-subscription:${inviter.id}:in_1`;
      const [queued] = await heldCreditRewardRepository.findByTransactionIds([transactionId]);
      expect(queued).toMatchObject({ status: 'held', expiresAt: new Date(NOW.getTime() + TTL_MS) });

      await setTricklePool(1_000_000);
      expect(
        await creditService.releaseHeldCreditRewards(buildCreditRewardAdapters(), {
          limit: 10,
          now: new Date(NOW.getTime() + TTL_MS - 1),
        })
      ).toMatchObject({ paid: 1, voided: 0, failed: 0 });
      expect((await User.findById(inviter.id))?.currentCredits).toBe(REWARD_CREDITS);
    }
  );

  describe('admin signup grant block', () => {
    const block = (userId: string) => User.updateOne({ _id: userId }, { $set: { 'signupGrant.blocked': { at: NOW } } });
    const reward = () => referralSubscriptionRewardRepository.findByInvoiceId('in_1');
    const seedPair = async () => {
      const inviter = await newUser('inviter');
      const payer = await newUser('friend');
      await seedRewardFor(inviter, payer);
      return { inviter, payer };
    };

    it('keeps the reward pending while the inviter is grant-blocked, then pays it after unblock', async () => {
      const { inviter } = await seedPair();
      await block(inviter.id);

      const blockedRun = await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid });

      expect(blockedRun).toMatchObject({ candidates: 1, released: 0, cancelled: 0, failed: 0 });
      expect(await reward()).toMatchObject({ status: 'pending' });
      expect((await User.findById(inviter.id))?.currentCredits).toBe(0);
      expect(await CreditTransaction.countDocuments({ ownerId: inviter.id })).toBe(0);

      await User.updateOne({ _id: inviter.id }, { $unset: { 'signupGrant.blocked': 1 } });

      expect(await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid })).toMatchObject({
        released: 1,
        cancelled: 0,
      });
      expect((await User.findById(inviter.id))?.currentCredits).toBe(REWARD_CREDITS);
      expect(await reward()).toMatchObject({ status: 'released' });
    });

    it('cancels a forfeited inviter reward so a capped run can reach the next reward', async () => {
      const { inviter } = await seedPair();
      await User.updateOne(
        { _id: inviter.id },
        { $set: { 'signupGrant.unlockForfeited': { cause: 'refund', at: NOW } } }
      );
      const nextInviter = await newUser('next-inviter');
      const nextPayer = await newUser('next-friend');
      await referralSubscriptionRewardRepository.create(
        {
          invoiceId: 'in_2',
          paymentIntentId: 'pi_2',
          inviterId: nextInviter.id,
          payerId: nextPayer.id,
          step: 'first_payment',
          credits: REWARD_CREDITS,
          releaseAt: new Date(NOW.getTime() - 30_000),
        },
        NOW
      );

      const run = await releaseDueSubscriptionRewards({ now: NOW, limit: 1, paymentOutcome: stillPaid });

      expect(run).toMatchObject({ candidates: 1, released: 0, cancelled: 1, failed: 0 });
      expect(await reward()).toMatchObject({ status: 'cancelled', closeReason: 'inviter_blocked' });
      expect((await User.findById(inviter.id))?.currentCredits).toBe(0);
      expect(await releaseDueSubscriptionRewards({ now: NOW, limit: 1, paymentOutcome: stillPaid })).toMatchObject({
        candidates: 1,
        released: 1,
        failed: 0,
      });
      expect((await User.findById(nextInviter.id))?.currentCredits).toBe(REWARD_CREDITS);
    });

    it('still pays the inviter when only the payer is grant-blocked', async () => {
      const { inviter, payer } = await seedPair();
      await block(payer.id);

      const result = await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid });

      expect(result).toMatchObject({ released: 1, cancelled: 0 });
      expect((await User.findById(inviter.id))?.currentCredits).toBe(REWARD_CREDITS);
    });

    it('cancels as inviter_blocked when the inviter account is banned', async () => {
      const { inviter } = await seedPair();
      await User.updateOne({ _id: inviter.id }, { isBanned: true });

      const result = await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid });

      expect(result).toMatchObject({ released: 0, cancelled: 1 });
      expect(await reward()).toMatchObject({ status: 'cancelled', closeReason: 'inviter_blocked' });
    });

    it('cancels as payer_blocked when the payer account is banned', async () => {
      const { payer } = await seedPair();
      await User.updateOne({ _id: payer.id }, { isBanned: true });

      const result = await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid });

      expect(result).toMatchObject({ released: 0, cancelled: 1 });
      expect(await reward()).toMatchObject({ status: 'cancelled', closeReason: 'payer_blocked' });
    });
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
      await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid });
      expect(await lotOf(inviter.id)).toMatchObject({ amount: REWARD_CREDITS });

      await refundAll();

      expect((await User.findById(inviter.id))?.currentCredits).toBe(0);
      expect(await lotOf(inviter.id)).toMatchObject({ amount: 0 });
    });

    it('never shrinks the lot below what was already spent from it', async () => {
      const inviter = await seedDueReward();
      await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid });
      const lot = await lotOf(inviter.id);
      await creditLotRepository.update({ id: lot.id, consumedAssigned: 2000 });
      await User.updateOne({ _id: inviter.id }, { currentCredits: REWARD_CREDITS - 2000 });

      await refundAll();

      expect((await User.findById(inviter.id))?.currentCredits).toBe(0);
      expect(await lotOf(inviter.id)).toMatchObject({ amount: 2000, consumedAssigned: 2000 });
    });
  });

  describe('trickle pool', () => {
    const REF = () => `referral-subscription:${inviterId}:in_1`;
    let inviterId = '';
    const heldRow = () => HeldCreditRewardModel.findOne({ transactionId: REF() }).lean();
    const reward = () => referralSubscriptionRewardRepository.findByInvoiceId('in_1');
    const balance = async () => (await User.findById(inviterId))?.currentCredits ?? 0;
    const refund = (amountRefunded: number, reason?: 'disputed') =>
      reverseSubscriptionRewardForRefund({
        paymentIntentId: 'pi_1',
        amountRefunded,
        amountCaptured: 3000,
        now: NOW,
        ...(reason ? { reason } : {}),
      });
    const releasePool = (adapters = buildCreditRewardAdapters()) =>
      creditService.releaseHeldCreditRewards(adapters, { limit: 10 });
    const releaseOnDryPool = async () => {
      inviterId = (await seedDueReward()).id;
      await setTricklePool(0);
      expect(await releaseDueSubscriptionRewards({ now: NOW, paymentOutcome: stillPaid })).toMatchObject({
        released: 1,
        failed: 0,
      });
    };

    it('queues the reward on a dry pool and pays it, with its lot, once the pool refills', async () => {
      await releaseOnDryPool();

      expect(await reward()).toMatchObject({ status: 'released' });
      expect(await heldRow()).toMatchObject({
        status: 'held',
        credits: REWARD_CREDITS,
        source: 'referral_subscription',
        lotRef: REF(),
      });
      expect(await balance()).toBe(0);

      await setTricklePool(1_000_000);
      expect(await releasePool()).toMatchObject({ paid: 1 });
      expect(await balance()).toBe(REWARD_CREDITS);
      expect(await creditLotRepository.findByStripeRef(REF())).toMatchObject([{ amount: REWARD_CREDITS }]);

      // The pool-paid reward is taken back from its own lot like a direct grant.
      await refund(3000);
      expect(await balance()).toBe(0);
      expect(await reward()).toMatchObject({ status: 'taken_back', takenBackCredits: REWARD_CREDITS });
    });

    it('preserves the deadline while queued and voids it instead of paying at expiry', async () => {
      await releaseOnDryPool();
      const queued = await heldRow();
      const recorded = await reward();
      const expiresAt = new Date(recorded!.releaseAt.getTime() + TTL_MS);
      expect(queued?.expiresAt).toEqual(expiresAt);
      await setTricklePool(1_000_000);

      expect(
        await creditService.releaseHeldCreditRewards(buildCreditRewardAdapters(), { limit: 10, now: expiresAt })
      ).toMatchObject({ paid: 0, voided: 1, failed: 0 });
      expect(await heldRow()).toMatchObject({ status: 'void' });
      expect(await balance()).toBe(0);
      expect(await CreditTransaction.countDocuments()).toBe(0);
    });

    it('pays a queued reward just before its deadline', async () => {
      await releaseOnDryPool();
      const queued = await heldRow();
      await setTricklePool(1_000_000);

      expect(
        await creditService.releaseHeldCreditRewards(buildCreditRewardAdapters(), {
          limit: 10,
          now: new Date(queued!.expiresAt!.getTime() - 1),
        })
      ).toMatchObject({ paid: 1, voided: 0, failed: 0 });
      expect(await balance()).toBe(REWARD_CREDITS);
    });

    it('expires historical queued subscription rewards without a stored deadline', async () => {
      await releaseOnDryPool();
      const queued = await heldRow();
      await HeldCreditRewardModel.updateOne({ transactionId: REF() }, { $unset: { expiresAt: 1 } });
      await setTricklePool(1_000_000);

      expect(
        await creditService.releaseHeldCreditRewards(buildCreditRewardAdapters(), {
          limit: 10,
          now: new Date(queued!.heldAt.getTime() + TTL_MS),
        })
      ).toMatchObject({ paid: 0, voided: 1, failed: 0 });
      expect(await balance()).toBe(0);
    });

    it.each([undefined, 'disputed' as const])(
      'voids the queued reward on a full refund (reason %s) without touching the balance',
      async reason => {
        await releaseOnDryPool();

        await refund(3000, reason);

        expect(await heldRow()).toMatchObject({ status: 'void' });
        expect(await reward()).toMatchObject({ status: 'taken_back', takenBackCredits: REWARD_CREDITS });
        await setTricklePool(1_000_000);
        expect(await releasePool()).toMatchObject({ paid: 0 });
        expect(await balance()).toBe(0);
        expect(await CreditTransaction.countDocuments({ ownerId: inviterId })).toBe(0);
      }
    );

    it('pays only the unrefunded share of a partly refunded queued reward', async () => {
      await releaseOnDryPool();

      await refund(1500);

      expect(await heldRow()).toMatchObject({ status: 'held', credits: REWARD_CREDITS / 2 });
      expect(await reward()).toMatchObject({ status: 'released', takenBackCredits: REWARD_CREDITS / 2 });
      await setTricklePool(1_000_000);
      expect(await releasePool()).toMatchObject({ paid: 1 });
      expect(await balance()).toBe(REWARD_CREDITS / 2);
    });

    it('rolls back a pool payout when a refund lowers the reward after the release listed it', async () => {
      await releaseOnDryPool();
      await setTricklePool(1_000_000);
      const adapters = buildCreditRewardAdapters();
      const racing = {
        ...adapters,
        heldRewards: {
          ...heldCreditRewardRepository,
          listHeld: async (limit: number, maxCredits?: number) => {
            const rows = await heldCreditRewardRepository.listHeld(limit, maxCredits);
            await refund(1500);
            return rows;
          },
        },
      };

      expect(await releasePool(racing)).toMatchObject({ paid: 0, failed: 0 });
      expect(await balance()).toBe(0);
      expect(await heldRow()).toMatchObject({ status: 'held', credits: REWARD_CREDITS / 2 });

      expect(await releasePool()).toMatchObject({ paid: 1 });
      expect(await balance()).toBe(REWARD_CREDITS / 2);
      expect(await CreditTransaction.countDocuments({ ownerId: inviterId })).toBe(1);
    });
  });
});
