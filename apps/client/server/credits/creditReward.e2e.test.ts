import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { creditService } from '@bike4mind/services';
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

  it('holds a new reward behind an older queued one even when the pool has room', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const older = await makeUser();
    await creditService.payCreditReward(reward(older.id, 'projects'), adapters);
    config.signupGrantTricklePoolDaily = '1000';
    const newer = await makeUser();
    expect((await creditService.payCreditReward(reward(newer.id, 'projects'), adapters)).outcome).toBe('queued');
    expect(await balance(newer.id)).toBe(0);
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
