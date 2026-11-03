import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { creditService, userService } from '@bike4mind/services';
import type { SignupProtection } from '@bike4mind/common';
import {
  mongoose,
  User,
  userRepository,
  creditTransactionRepository,
  CreditTransaction,
  HeldCreditRewardModel,
  heldCreditRewardRepository,
  signupGrantBudgetRepository,
  SignupGrantBudgetDayModel,
  withTransaction,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const config: Record<string, string> = {};
const adminSettings = {
  findBySettingName: async (key: string) => (key in config ? { settingValue: config[key] } : null),
};
const signupProtection = {
  grantBudget: { repository: signupGrantBudgetRepository, heldRewards: heldCreditRewardRepository },
} as unknown as SignupProtection;
const adapters: creditService.PayCreditRewardAdapters = {
  db: { creditTransactions: creditTransactionRepository },
  creditHolderMethods: userRepository,
  heldRewards: heldCreditRewardRepository,
  users: userRepository,
  adminSettings,
  signupProtection,
};

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await CreditTransaction.createCollection();
  await SignupGrantBudgetDayModel.createCollection();
  await HeldCreditRewardModel.createCollection();
  await HeldCreditRewardModel.syncIndexes();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  for (const model of [User, CreditTransaction, SignupGrantBudgetDayModel, HeldCreditRewardModel])
    await model.collection.deleteMany({});
  config.signupGrantTricklePoolDaily = '1000';
});

let n = 0;
const makeUser = (extra: Record<string, unknown> = {}) =>
  User.create({ username: `reward-user-${++n}`, name: 'Synthetic User', email: `reward${n}@example.test`, ...extra });
const reward = (userId: string, key: string, credits = 100) => ({
  transactionId: `gear-unlock:${userId}:${key}`,
  userId,
  credits,
  source: 'gear' as const,
  reason: `gear unlock: ${key}`,
  description: `Gear unlock reward: ${key}`,
});
const trickleKey = () => `trickle:${new Date().toISOString().slice(0, 10)}`;
const balance = async (id: string) => (await User.findById(id).lean())?.currentCredits ?? 0;

describe('payCreditReward', () => {
  it('pays from the trickle pool and tags the ledger row with its source', async () => {
    const user = await makeUser();
    const result = await creditService.payCreditReward(reward(user.id, 'projects'), adapters);
    expect(result.outcome).toBe('paid');
    expect(await balance(user.id)).toBe(100);
    const row = await CreditTransaction.findOne({ transactionId: `gear-unlock:${user.id}:projects` }).lean();
    expect(row).toMatchObject({ reason: 'gear unlock: projects', metadata: { rewardSource: 'gear' } });
    expect(await signupGrantBudgetRepository.getSpent(`trickle:${new Date().toISOString().slice(0, 10)}`)).toBe(100);
  });

  it('queues on a dry pool, keeps one row on a repeat claim, and releases oldest first on refill', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const first = await makeUser();
    const second = await makeUser();
    expect((await creditService.payCreditReward(reward(first.id, 'projects'), adapters)).outcome).toBe('queued');
    expect((await creditService.payCreditReward(reward(first.id, 'projects'), adapters)).outcome).toBe('queued');
    expect((await creditService.payCreditReward(reward(second.id, 'projects'), adapters)).outcome).toBe('queued');
    expect(await HeldCreditRewardModel.countDocuments({ userId: first.id })).toBe(1);
    expect(await balance(first.id)).toBe(0);

    // Room for one: the older reward pays, the newer one keeps waiting.
    config.signupGrantTricklePoolDaily = '150';
    const released = await creditService.releaseHeldCreditRewards(adapters, { limit: 10 });
    expect(released).toMatchObject({ paid: 1, budgetExhausted: true });
    expect(await balance(first.id)).toBe(100);
    expect(await balance(second.id)).toBe(0);
    expect(await HeldCreditRewardModel.findOne({ userId: first.id }).lean()).toMatchObject({ status: 'paid' });
  });

  it('pays a new reward while the pool still covers the oldest queued one, and queues it otherwise', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const older = await makeUser();
    await creditService.payCreditReward(reward(older.id, 'projects'), adapters);
    config.signupGrantTricklePoolDaily = '150';
    const newer = await makeUser();
    expect((await creditService.payCreditReward(reward(newer.id, 'projects'), adapters)).outcome).toBe('queued');
    expect(await balance(newer.id)).toBe(0);

    config.signupGrantTricklePoolDaily = '1000';
    const roomy = await makeUser();
    expect((await creditService.payCreditReward(reward(roomy.id, 'projects'), adapters)).outcome).toBe('paid');
    expect(await balance(roomy.id)).toBe(100);
  });

  it('queues on a draw another attempt owns and leaves that draw in place', async () => {
    const user = await makeUser();
    const { transactionId } = reward(user.id, 'projects');
    await signupGrantBudgetRepository.reserve(trickleKey(), transactionId, 100, 1000);
    expect((await creditService.payCreditReward(reward(user.id, 'projects'), adapters)).outcome).toBe('queued');
    expect(await balance(user.id)).toBe(0);
    expect(await CreditTransaction.countDocuments({ transactionId })).toBe(0);
    expect(await signupGrantBudgetRepository.getSpent(trickleKey())).toBe(100);
    expect(await HeldCreditRewardModel.findOne({ transactionId }).lean()).toMatchObject({ status: 'held' });
  });

  it('does not let a queued reward larger than the whole pool block the queue or new rewards', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const huge = await makeUser();
    const small = await makeUser();
    await creditService.payCreditReward(reward(huge.id, 'projects', 5000), adapters);
    await creditService.payCreditReward(reward(small.id, 'projects'), adapters);
    config.signupGrantTricklePoolDaily = '1000';
    // An untouched day lets one oversized grant draw (SignupGrantBudgetModel reserve); spend first so it cannot.
    await signupGrantBudgetRepository.reserve(trickleKey(), 'earlier-drip', 100, 1000);
    const released = await creditService.releaseHeldCreditRewards(adapters, { limit: 10 });
    expect(released).toMatchObject({ paid: 1, budgetExhausted: false });
    expect(await balance(small.id)).toBe(100);
    expect(await HeldCreditRewardModel.findOne({ userId: huge.id }).lean()).toMatchObject({ status: 'held' });
    const fresh = await makeUser();
    expect((await creditService.payCreditReward(reward(fresh.id, 'projects'), adapters)).outcome).toBe('paid');
  });

  it('leaves an oversized reward out of the release scan so it cannot starve a payable one behind it', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const huge = await makeUser();
    const small = await makeUser();
    await creditService.payCreditReward(reward(huge.id, 'projects', 500), adapters);
    await creditService.payCreditReward(reward(small.id, 'projects', 50), adapters);
    config.signupGrantTricklePoolDaily = '100';
    const released = await creditService.releaseHeldCreditRewards(adapters, { limit: 1 });
    expect(released).toMatchObject({ scanned: 1, paid: 1 });
    expect(await balance(small.id)).toBe(50);
    expect(await balance(huge.id)).toBe(0);
    expect(await HeldCreditRewardModel.findOne({ userId: huge.id }).lean()).toMatchObject({ status: 'held' });
  });

  it('queues a new reward behind a payable reward waiting behind an oversized head', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const huge = await makeUser();
    const small = await makeUser();
    await creditService.payCreditReward(reward(huge.id, 'projects', 5000), adapters);
    await creditService.payCreditReward(reward(small.id, 'projects'), adapters);
    config.signupGrantTricklePoolDaily = '150';
    const newer = await makeUser();
    expect((await creditService.payCreditReward(reward(newer.id, 'projects'), adapters)).outcome).toBe('queued');
    expect(await signupGrantBudgetRepository.getSpent(trickleKey())).toBe(0);
  });

  it('keeps the draw spent when the payout throws after its ledger row committed', async () => {
    const user = await makeUser();
    const creditHolderMethods = {
      ...userRepository,
      incrementCredits: async () => {
        throw new Error('balance write failed');
      },
    } as unknown as typeof userRepository;
    await expect(
      creditService.payCreditReward(reward(user.id, 'projects'), { ...adapters, creditHolderMethods })
    ).rejects.toThrow('balance write failed');
    expect(await CreditTransaction.countDocuments({ transactionId: reward(user.id, 'projects').transactionId })).toBe(
      1
    );
    expect(await signupGrantBudgetRepository.getSpent(trickleKey())).toBe(100);
  });

  it('keeps the draw and still throws when the ledger cannot be read after the balance credit fails', async () => {
    const user = await makeUser();
    const paying = reward(user.id, 'projects');
    const creditHolderMethods = {
      ...userRepository,
      incrementCredits: async () => {
        throw new Error('balance write failed');
      },
    } as unknown as typeof userRepository;
    let reads = 0;
    const creditTransactions = Object.assign(Object.create(creditTransactionRepository), {
      findOne: async (filter: { transactionId: string }) => {
        if (++reads === 1) return creditTransactionRepository.findOne(filter);
        throw new Error('ledger read failed');
      },
    }) as typeof creditTransactionRepository;
    await expect(
      creditService.payCreditReward(paying, { ...adapters, creditHolderMethods, db: { creditTransactions } })
    ).rejects.toThrow('balance write failed');
    expect(reads).toBeGreaterThan(1);
    expect(await signupGrantBudgetRepository.getSpent(trickleKey())).toBe(100);
  });

  it('treats its own earlier draw as fresh when a transaction retries inside one refund scope', async () => {
    await userService.refundBudgetOnFailure(async () => {
      const first = await userService.reserveSignupGrantBudget(adapters, 'retry-tx', 100, { pool: 'trickle' });
      const retry = await userService.reserveSignupGrantBudget(adapters, 'retry-tx', 100, { pool: 'trickle' });
      expect([first.fresh, retry.fresh]).toEqual([true, true]);
    });
    expect(await signupGrantBudgetRepository.getSpent(trickleKey())).toBe(100);
  });

  it('keeps releasing past a reward that throws', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const broken = await makeUser();
    const healthy = await makeUser();
    await creditService.payCreditReward(reward(broken.id, 'projects'), adapters);
    await creditService.payCreditReward(reward(healthy.id, 'projects'), adapters);
    config.signupGrantTricklePoolDaily = '1000';
    const users = {
      findById: async (id: string) => {
        if (id === broken.id) throw new Error('lookup failed');
        return userRepository.findById(id);
      },
    };
    const released = await creditService.releaseHeldCreditRewards({ ...adapters, users }, { limit: 10 });
    expect(released).toMatchObject({ paid: 1, failed: 1 });
    expect(await balance(healthy.id)).toBe(100);
    expect(await HeldCreditRewardModel.findOne({ userId: broken.id }).lean()).toMatchObject({ status: 'held' });
  });

  it('answers blocked, not duplicate, for a reward voided at release', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const user = await makeUser();
    await creditService.payCreditReward(reward(user.id, 'projects'), adapters);
    await User.updateOne({ _id: user.id }, { isBanned: true });
    config.signupGrantTricklePoolDaily = '1000';
    await creditService.releaseHeldCreditRewards(adapters, { limit: 10 });
    await User.updateOne({ _id: user.id }, { isBanned: false });
    expect((await creditService.payCreditReward(reward(user.id, 'projects'), adapters)).outcome).toBe('blocked');
    expect(await balance(user.id)).toBe(0);
  });

  it('keeps a suspend_pending account queued and voids a deleted friend at release', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const pending = await makeUser();
    const inviter = await makeUser();
    const friend = await makeUser();
    await creditService.payCreditReward(reward(pending.id, 'projects'), adapters);
    const referral = {
      ...reward(inviter.id, 'referral'),
      source: 'referral_first_answer' as const,
      metadata: { [creditService.REFERRED_USER_ID_METADATA_KEY]: friend.id },
    };
    await creditService.payCreditReward(referral, adapters);
    await User.updateOne({ _id: pending.id }, { 'moderation.status': 'suspend_pending' });
    // deletedAt is not on the User schema; soft delete writes it through the raw driver (db-core mongo.ts).
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(friend.id) },
      { $set: { deletedAt: new Date() } }
    );
    config.signupGrantTricklePoolDaily = '1000';
    expect(await creditService.releaseHeldCreditRewards(adapters, { limit: 10 })).toMatchObject({
      paid: 0,
      voided: 1,
      deferred: 1,
    });
    expect(await balance(pending.id)).toBe(0);
    expect(await balance(inviter.id)).toBe(0);

    await User.updateOne({ _id: pending.id }, { 'moderation.status': 'active' });
    expect(await creditService.releaseHeldCreditRewards(adapters, { limit: 10 })).toMatchObject({ paid: 1 });
    expect(await balance(pending.id)).toBe(100);
  });

  it('pays and queues nothing for a blocked account, and voids a queued reward once its account is blocked', async () => {
    const banned = await makeUser({ isBanned: true });
    expect((await creditService.payCreditReward(reward(banned.id, 'projects'), adapters)).outcome).toBe('blocked');
    expect(await HeldCreditRewardModel.countDocuments({})).toBe(0);

    config.signupGrantTricklePoolDaily = '0';
    const later = await makeUser();
    await creditService.payCreditReward(reward(later.id, 'projects'), adapters);
    await User.updateOne({ _id: later.id }, { isBanned: true });
    config.signupGrantTricklePoolDaily = '1000';
    expect(await creditService.releaseHeldCreditRewards(adapters, { limit: 10 })).toMatchObject({ paid: 0, voided: 1 });
    expect(await balance(later.id)).toBe(0);
  });

  it('answers duplicate for a reward already in the ledger', async () => {
    const user = await makeUser();
    await creditService.payCreditReward(reward(user.id, 'projects'), adapters);
    expect((await creditService.payCreditReward(reward(user.id, 'projects'), adapters)).outcome).toBe('duplicate');
    expect(await balance(user.id)).toBe(100);
  });
});

describe('payCreditReward in its own transaction', () => {
  const txAdapters: creditService.PayCreditRewardAdapters = {
    ...adapters,
    withTransaction: fn => withTransaction(() => fn()),
  };
  const failingBalance = {
    ...userRepository,
    incrementCredits: async () => {
      throw new Error('balance write failed');
    },
  } as unknown as typeof userRepository;
  const referral = (inviterId: string, friendId: string) => ({
    transactionId: `referral-first-answer:${inviterId}:${friendId}`,
    userId: inviterId,
    credits: 100,
    source: 'referral_first_answer' as const,
    reason: 'referral_reward',
    description: 'Referral reward: first answer from an invited friend',
    metadata: { [creditService.REFERRED_USER_ID_METADATA_KEY]: friendId },
  });

  it('rolls back the ledger row and refunds the draw when the referral balance credit throws, then pays once on retry', async () => {
    const inviter = await makeUser();
    const friend = await makeUser();
    const paying = referral(inviter.id, friend.id);
    await expect(
      creditService.payCreditReward(paying, { ...txAdapters, creditHolderMethods: failingBalance })
    ).rejects.toThrow('balance write failed');
    expect(await CreditTransaction.countDocuments({ transactionId: paying.transactionId })).toBe(0);
    expect(await balance(inviter.id)).toBe(0);
    expect(await signupGrantBudgetRepository.getSpent(trickleKey())).toBe(0);

    expect((await creditService.payCreditReward(paying, txAdapters)).outcome).toBe('paid');
    expect((await creditService.payCreditReward(paying, txAdapters)).outcome).toBe('duplicate');
    expect(await CreditTransaction.countDocuments({ transactionId: paying.transactionId })).toBe(1);
    expect(await balance(inviter.id)).toBe(100);
    expect(await signupGrantBudgetRepository.getSpent(trickleKey())).toBe(100);
  });

  it('rolls back the ledger row and refunds the draw when a released reward balance credit throws, then pays once on the next run', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const inviter = await makeUser();
    const friend = await makeUser();
    const queued = referral(inviter.id, friend.id);
    expect((await creditService.payCreditReward(queued, txAdapters)).outcome).toBe('queued');
    config.signupGrantTricklePoolDaily = '1000';

    const failed = await creditService.releaseHeldCreditRewards(
      { ...txAdapters, creditHolderMethods: failingBalance },
      { limit: 10 }
    );
    expect(failed).toMatchObject({ paid: 0, failed: 1 });
    expect(await CreditTransaction.countDocuments({ transactionId: queued.transactionId })).toBe(0);
    expect(await balance(inviter.id)).toBe(0);
    expect(await signupGrantBudgetRepository.getSpent(trickleKey())).toBe(0);
    expect(await HeldCreditRewardModel.findOne({ transactionId: queued.transactionId }).lean()).toMatchObject({
      status: 'held',
    });

    expect(await creditService.releaseHeldCreditRewards(txAdapters, { limit: 10 })).toMatchObject({ paid: 1 });
    expect(await creditService.releaseHeldCreditRewards(txAdapters, { limit: 10 })).toMatchObject({ scanned: 0 });
    expect(await CreditTransaction.countDocuments({ transactionId: queued.transactionId })).toBe(1);
    expect(await balance(inviter.id)).toBe(100);
    expect(await signupGrantBudgetRepository.getSpent(trickleKey())).toBe(100);
  });

  it('answers duplicate and refunds the draw when the ledger row lands between the check and the insert', async () => {
    const user = await makeUser();
    const paying = reward(user.id, 'projects');
    await CreditTransaction.create({
      type: 'generic_add',
      ownerId: user.id,
      ownerType: 'User',
      credits: 100,
      transactionId: paying.transactionId,
      reason: paying.reason,
      description: paying.description,
    });
    const creditTransactions = Object.assign(Object.create(creditTransactionRepository), {
      findOne: async () => null,
    }) as typeof creditTransactionRepository;
    const result = await creditService.payCreditReward(paying, {
      ...txAdapters,
      db: { creditTransactions },
    });
    expect(result.outcome).toBe('duplicate');
    expect(await balance(user.id)).toBe(0);
    expect(await signupGrantBudgetRepository.getSpent(trickleKey())).toBe(0);
  });
});
