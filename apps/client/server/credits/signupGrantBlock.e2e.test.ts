import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { creditService, userService } from '@bike4mind/services';
import { rerunDomainGrantAfterUnblock } from './rerunDomainGrantAfterUnblock';
import { newSignupGrant, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
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
  signupGrantReleaseRepository,
  SignupGrantBudgetDayModel,
  AdminSettings,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@server/entitlements/partnerRules', () => ({
  partnerSignupGrantForEmail: async () => ({
    matched: true,
    ruleId: 'rule-1',
    domain: 'partner.example',
    entitlements: new Set<string>(),
    signupCredits: 250,
    organizationId: null,
    tags: [],
    subscription: null,
    grantPackageId: null,
  }),
}));
vi.mock('@server/entitlements/invalidate', () => ({
  pushEntitlementInvalidation: async () => {},
  pushSubscriptionsInvalidation: async () => {},
}));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const config: Record<string, string> = {};
const adminSettings = {
  findBySettingName: async (key: string) => (key in config ? { settingValue: config[key] } : null),
  findBySettingNames: async (keys: string[]) =>
    keys.filter(key => key in config).map(key => ({ settingName: key, settingValue: config[key] })),
} as unknown as Parameters<typeof newSignupGrant>[0];
const signupProtection = {
  grantBudget: { repository: signupGrantBudgetRepository, heldRewards: heldCreditRewardRepository },
} as unknown as SignupProtection;
// What production passes on the verify and held-release paths: domain protection plus the pool budget.
const meteredProtection: SignupProtection = {
  repository: {
    findReview: async () => null,
    observe: async () => {},
    recent: async () => [],
    createHold: async () => false,
    isOrganizationDomain: async () => false,
  },
  grantBudget: { repository: signupGrantBudgetRepository },
};
const rewardAdapters: creditService.PayCreditRewardAdapters = {
  db: { creditTransactions: creditTransactionRepository },
  creditHolderMethods: userRepository,
  heldRewards: heldCreditRewardRepository,
  users: userRepository,
  adminSettings,
  signupProtection,
};
const grantAdapters = {
  db: { users: userRepository, creditTransactions: creditTransactionRepository, adminSettings },
  reason: 'synthetic signup',
  validators: { admin: async () => true },
  audit: async () => {},
};
const blockAdapters = { users: userRepository, heldRewards: heldCreditRewardRepository };

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
  await AdminSettings.createCollection();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
  await User.collection.createIndex(
    { freeCreditClaimEmail: 1 },
    { unique: true, partialFilterExpression: { freeCreditClaimEmail: { $type: 'string' } } }
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  for (const model of [User, CreditTransaction, SignupGrantBudgetDayModel, HeldCreditRewardModel, AdminSettings])
    await model.collection.deleteMany({});
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, {
    stagedSignupGrantEnabled: 'true',
    signupGrantCredits: '12',
    verifiedUnlockCredits: '28',
    signupUnlockPaymentHoldHours: '0',
    signupGrantTricklePoolDaily: '1000',
  });
  // A missing pool setting pauses grants, so the grant tests start with both pools effectively uncapped.
  await AdminSettings.insertMany([
    { settingName: 'signupGrantSignupPoolDaily', settingValue: '1000000000' },
    { settingName: 'signupGrantTricklePoolDaily', settingValue: '1000000000' },
  ]);
});

let n = 0;
const makeUser = async (extra: Record<string, unknown> = {}) =>
  User.create({
    username: `block-user-${++n}`,
    name: 'Synthetic User',
    email: `block${n}@example.test`,
    emailVerified: true,
    ...extra,
  });
const makeGrantUser = async (extra: Record<string, unknown> = {}) =>
  makeUser({ signupGrant: await newSignupGrant(adminSettings), ...extra });
const reward = (userId: string, key: string, extra: Record<string, unknown> = {}) => ({
  transactionId: `gear-unlock:${userId}:${key}`,
  userId,
  credits: 100,
  source: 'gear' as const,
  reason: `gear unlock: ${key}`,
  description: `Gear unlock reward: ${key}`,
  ...extra,
});
const balance = async (id: string) => (await User.findById(id).lean())?.currentCredits ?? 0;
const rawUser = (id: string) => User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

describe('block and unblock against a real database', () => {
  it('stores only a time on the grant, and unblock removes it while keeping the rest of the grant', async () => {
    const user = await makeGrantUser();

    expect(await userService.blockSignupGrant(user.id, blockAdapters)).toMatchObject({ outcome: 'applied' });
    const blocked = await rawUser(user.id);
    expect(Object.keys(blocked?.signupGrant.blocked)).toEqual(['at']);
    expect(blocked?.signupGrant).toMatchObject({ stage: 'pending_email', signupCredits: 12, unlockCredits: 28 });

    expect(await userService.unblockSignupGrant(user.id, blockAdapters)).toMatchObject({ outcome: 'applied' });
    const lifted = await rawUser(user.id);
    expect(lifted?.signupGrant).not.toHaveProperty('blocked');
    expect(lifted?.signupGrant).toMatchObject({ stage: 'pending_email', signupCredits: 12, unlockCredits: 28 });
  });

  it('keeps the account untouched when the audit hook throws, so no block lands without its entry', async () => {
    const user = await makeGrantUser();
    const failing = { ...blockAdapters, audit: async () => Promise.reject(new Error('audit down')) };

    await expect(userService.blockSignupGrant(user.id, failing)).rejects.toThrow('audit down');
    expect((await rawUser(user.id))?.signupGrant).not.toHaveProperty('blocked');
  });
});

describe('a blocked grant pays nothing, from any path', () => {
  it('pays no tranche, withholds it with the pending tag kept, and pays it after unblock', async () => {
    const user = await makeGrantUser({ tags: [PENDING_FREE_CREDITS_TAG] });
    await userService.blockSignupGrant(user.id, blockAdapters);

    const tranche = await userService.releaseSignupTranche(user.id, grantAdapters);
    expect(tranche).toMatchObject({ creditsGranted: 0, withheld: true });

    // releasePendingFreeCredits strips the tag on a non-withheld zero, which would strand the tranche.
    const release = await userService.releasePendingFreeCredits(
      { id: user.id, tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: null },
      { ...grantAdapters, logger: { error: () => {} } }
    );
    expect(release).toMatchObject({ released: false, patch: {} });
    expect(await balance(user.id)).toBe(0);
    expect((await rawUser(user.id))?.tags).toContain(PENDING_FREE_CREDITS_TAG);

    await userService.unblockSignupGrant(user.id, blockAdapters);
    const queued = await rawUser(user.id);
    expect(queued?.signupGrantHeldReason).toBe('budget_exhausted');
    expect(queued?.tags).toContain(PENDING_FREE_CREDITS_TAG);

    const paid = await userService.releasePendingFreeCredits(
      { id: user.id, tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: null },
      { ...grantAdapters, logger: { error: () => {} } }
    );
    expect(paid.released).toBe(true);
    expect(await balance(user.id)).toBe(12);
  });

  it('pays no remainder while blocked, then pays it once after unblock without stamping paid standing', async () => {
    const user = await makeGrantUser();
    await userService.releaseSignupTranche(user.id, grantAdapters);
    expect(await balance(user.id)).toBe(12);
    await userService.blockSignupGrant(user.id, blockAdapters);

    expect(await userService.releaseRemainingSignupGrant(user.id, grantAdapters)).toEqual({
      outcome: 'noop',
      reason: 'blocked',
    });
    expect(await userService.unlockSignupGrant(user.id, 'admin', grantAdapters)).toMatchObject({ creditsGranted: 0 });
    expect(await balance(user.id)).toBe(12);

    await userService.unblockSignupGrant(user.id, blockAdapters);
    expect(await userService.releaseRemainingSignupGrant(user.id, grantAdapters)).toEqual({
      outcome: 'applied',
      credits: 28,
    });
    expect(await balance(user.id)).toBe(40);

    const row = await CreditTransaction.findOne({ reason: 'signup_unlock:admin' }).lean();
    expect(row).toMatchObject({ type: 'generic_add', credits: 28 });
    // Only a purchase stamps this; it confers paid standing, which a released grant must not.
    expect((await rawUser(user.id))?.lastCreditsPurchasedAt ?? null).toBeNull();
    expect(await userService.releaseRemainingSignupGrant(user.id, grantAdapters)).toEqual({
      outcome: 'noop',
      reason: 'nothing_remaining',
    });
  });

  it('answers a release on an account with no grant with a reason rather than a silent zero', async () => {
    const user = await makeUser();

    expect(await userService.releaseRemainingSignupGrant(user.id, grantAdapters)).toEqual({
      outcome: 'noop',
      reason: 'no_grant',
    });
    expect(await userService.blockSignupGrant(user.id, blockAdapters)).toMatchObject({
      outcome: 'noop',
      reason: 'no_grant',
    });
  });
});

describe('a blocked holder is out of every held-grant scan', () => {
  const heldAt = new Date('2026-11-01T00:00:00.000Z');
  const heldUser = () =>
    makeGrantUser({
      tags: [PENDING_FREE_CREDITS_TAG],
      signupGrantHeldReason: 'budget_exhausted',
      signupGrantHeldAt: heldAt,
    });

  it('stops counting as signup backlog and leaves the held-release scan, and returns when unblocked', async () => {
    const user = await heldUser();
    const listed = async () =>
      (await signupGrantReleaseRepository.listHeld({ reason: 'budget_exhausted', payableOnly: true, limit: 10 })).map(
        row => row.id
      );
    expect(await userService.hasSignupBacklog(userRepository, '2026-11-05')).toBe(true);
    expect(await listed()).toEqual([user.id]);

    await userService.blockSignupGrant(user.id, blockAdapters);
    expect(await userService.hasSignupBacklog(userRepository, '2026-11-05')).toBe(false);
    expect(await listed()).toEqual([]);

    await userService.unblockSignupGrant(user.id, blockAdapters);
    expect(await userService.hasSignupBacklog(userRepository, '2026-11-05')).toBe(true);
    expect(await listed()).toEqual([user.id]);
  });

  it('leaves the due held payment unlock scan while blocked', async () => {
    const user = await makeGrantUser({});
    await User.collection.updateOne(
      { _id: user._id },
      { $set: { 'signupGrant.heldUnlock': { reason: 'card_verified', heldAt, releaseAt: heldAt } } }
    );
    const due = async () =>
      signupGrantReleaseRepository.listDueHeldUnlocks({ now: new Date('2026-11-04T00:00:00.000Z'), limit: 10 });
    expect(await due()).toEqual([user.id]);

    await userService.blockSignupGrant(user.id, blockAdapters);
    expect(await due()).toEqual([]);
  });
});

describe('queued rewards while blocked', () => {
  it('pauses them out of the queue so they cannot stall the head, and restores them in place on unblock', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const blocked = await makeGrantUser();
    const other = await makeUser();
    await creditService.payCreditReward(reward(blocked.id, 'projects'), rewardAdapters);
    await creditService.payCreditReward(reward(other.id, 'projects'), rewardAdapters);
    const original = await HeldCreditRewardModel.findOne({ userId: blocked.id }).lean();

    const result = await userService.blockSignupGrant(blocked.id, blockAdapters);
    expect(result).toMatchObject({ outcome: 'applied', rewardsAffected: 1 });
    expect(await HeldCreditRewardModel.findOne({ userId: blocked.id }).lean()).toMatchObject({ status: 'paused' });

    // The blocked user's older reward is no longer the head, so the other user's pays.
    config.signupGrantTricklePoolDaily = '150';
    const released = await creditService.releaseHeldCreditRewards(rewardAdapters, { limit: 10 });
    expect(released).toMatchObject({ paid: 1 });
    expect(await balance(other.id)).toBe(100);
    expect(await balance(blocked.id)).toBe(0);

    await userService.unblockSignupGrant(blocked.id, blockAdapters);
    const restored = await HeldCreditRewardModel.findOne({ userId: blocked.id }).lean();
    expect(restored).toMatchObject({ status: 'held' });
    expect(restored?.heldAt).toEqual(original?.heldAt);

    config.signupGrantTricklePoolDaily = '1000';
    expect(await creditService.releaseHeldCreditRewards(rewardAdapters, { limit: 10 })).toMatchObject({ paid: 1 });
    expect(await balance(blocked.id)).toBe(100);
  });

  it('pays a blocked recipient nothing and queues nothing for them', async () => {
    const user = await makeGrantUser();
    await userService.blockSignupGrant(user.id, blockAdapters);

    expect((await creditService.payCreditReward(reward(user.id, 'projects'), rewardAdapters)).outcome).toBe('blocked');
    expect(await HeldCreditRewardModel.countDocuments({ userId: user.id })).toBe(0);
    expect(await balance(user.id)).toBe(0);
  });

  it('pays nothing when the block lands between the up-front check and the payout write', async () => {
    const user = await makeGrantUser();
    let reads = 0;
    const racingUsers = new Proxy(userRepository, {
      get(target, key) {
        if (key !== 'findById') return Reflect.get(target, key, target);
        return async (id: string) => {
          // The first read is the up-front check; the second is the payout's own read.
          if (++reads === 2) await userService.blockSignupGrant(id, blockAdapters);
          return userRepository.findById(id);
        };
      },
    });

    const result = await creditService.payCreditReward(reward(user.id, 'projects'), {
      ...rewardAdapters,
      users: racingUsers,
    });

    expect(result.outcome).toBe('blocked');
    expect(await balance(user.id)).toBe(0);
    expect(await CreditTransaction.countDocuments({ ownerId: user.id })).toBe(0);
    expect(await HeldCreditRewardModel.countDocuments({ userId: user.id })).toBe(0);
  });

  it('pauses a reward queued in the same instant the block landed, so no held row is left behind', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const user = await makeGrantUser();
    const racingRewards = new Proxy(heldCreditRewardRepository, {
      get(target, key) {
        if (key !== 'hold') return Reflect.get(target, key, target);
        // The block commits and pauses before the row exists, so its pause has nothing to move.
        return async (input: Parameters<typeof heldCreditRewardRepository.hold>[0]) => {
          await userService.blockSignupGrant(user.id, blockAdapters);
          return heldCreditRewardRepository.hold(input);
        };
      },
    });

    const result = await creditService.payCreditReward(reward(user.id, 'projects'), {
      ...rewardAdapters,
      heldRewards: racingRewards,
    });

    expect(result.outcome).toBe('blocked');
    expect(await HeldCreditRewardModel.findOne({ userId: user.id }).lean()).toMatchObject({ status: 'paused' });
    expect(await HeldCreditRewardModel.countDocuments({ userId: user.id, status: 'held' })).toBe(0);
  });

  it('pauses only the row it queued on a late block, leaving the same users other held rows queued', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const user = await makeGrantUser();
    await creditService.payCreditReward(reward(user.id, 'projects'), rewardAdapters);
    const racingRewards = new Proxy(heldCreditRewardRepository, {
      get(target, key) {
        if (key !== 'hold') return Reflect.get(target, key, target);
        // Sets the flag without pausing, as a block whose pause has not run yet.
        return async (input: Parameters<typeof heldCreditRewardRepository.hold>[0]) => {
          await heldCreditRewardRepository.hold(input);
          await User.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(user.id) },
            { $set: { 'signupGrant.blocked': { at: new Date() } } }
          );
        };
      },
    });

    const result = await creditService.payCreditReward(reward(user.id, 'skills'), {
      ...rewardAdapters,
      heldRewards: racingRewards,
    });

    expect(result.outcome).toBe('blocked');
    expect(
      await HeldCreditRewardModel.findOne({ transactionId: `gear-unlock:${user.id}:skills` }).lean()
    ).toMatchObject({
      status: 'paused',
    });
    expect(
      await HeldCreditRewardModel.findOne({ transactionId: `gear-unlock:${user.id}:projects` }).lean()
    ).toMatchObject({ status: 'held' });
  });

  it('still pays an inviter whose invited friend is blocked, since the block follows the recipient only', async () => {
    const inviter = await makeUser();
    const friend = await makeGrantUser();
    await userService.blockSignupGrant(friend.id, blockAdapters);
    const referral = reward(inviter.id, 'unused', {
      transactionId: `referral-first-answer:${inviter.id}:${friend.id}`,
      source: 'referral_first_answer',
      metadata: { referredUserId: friend.id },
    });

    expect((await creditService.payCreditReward(referral, rewardAdapters)).outcome).toBe('paid');
    expect(await balance(inviter.id)).toBe(100);
  });

  it('does not count a paused reward as the queue head, so it cannot make a new reward wait', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const blocked = await makeGrantUser();
    await creditService.payCreditReward(reward(blocked.id, 'projects'), rewardAdapters);
    await userService.blockSignupGrant(blocked.id, blockAdapters);

    // With the paused row at the head the pool (150) could not cover it plus this reward (100 + 100).
    config.signupGrantTricklePoolDaily = '150';
    const other = await makeUser();
    expect((await creditService.payCreditReward(reward(other.id, 'skills'), rewardAdapters)).outcome).toBe('paid');
  });
});

describe('a block or unblock whose reward write fails once', () => {
  const failingOnce = (method: 'pauseForUser' | 'resumeForUser') => {
    let failed = false;
    return new Proxy(heldCreditRewardRepository, {
      get(target, key) {
        if (key !== method) return Reflect.get(target, key, target);
        return async (userId: string) => {
          if (!failed) {
            failed = true;
            throw new Error(`${method} failed`);
          }
          return heldCreditRewardRepository[method](userId);
        };
      },
    });
  };

  it('keeps the flag set and the rewards held, defers them at release, and a repeat block pauses them', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const user = await makeGrantUser();
    await creditService.payCreditReward(reward(user.id, 'projects'), rewardAdapters);

    await expect(
      userService.blockSignupGrant(user.id, { ...blockAdapters, heldRewards: failingOnce('pauseForUser') })
    ).rejects.toThrow('pauseForUser failed');
    expect((await rawUser(user.id))?.signupGrant.blocked).toBeDefined();
    expect(await HeldCreditRewardModel.findOne({ userId: user.id }).lean()).toMatchObject({ status: 'held' });

    config.signupGrantTricklePoolDaily = '1000';
    expect(await creditService.releaseHeldCreditRewards(rewardAdapters, { limit: 10 })).toMatchObject({
      deferred: 1,
      voided: 0,
      paid: 0,
    });
    expect(await HeldCreditRewardModel.findOne({ userId: user.id }).lean()).toMatchObject({ status: 'held' });
    expect(await balance(user.id)).toBe(0);

    expect(await userService.blockSignupGrant(user.id, blockAdapters)).toMatchObject({
      outcome: 'noop',
      reason: 'already_blocked',
      rewardsAffected: 1,
    });
    expect(await HeldCreditRewardModel.findOne({ userId: user.id }).lean()).toMatchObject({ status: 'paused' });
  });

  it('keeps the flag lifted and the rewards paused, and a repeat unblock resumes them', async () => {
    config.signupGrantTricklePoolDaily = '0';
    const user = await makeGrantUser();
    await creditService.payCreditReward(reward(user.id, 'projects'), rewardAdapters);
    await userService.blockSignupGrant(user.id, blockAdapters);

    await expect(
      userService.unblockSignupGrant(user.id, { ...blockAdapters, heldRewards: failingOnce('resumeForUser') })
    ).rejects.toThrow('resumeForUser failed');
    expect((await rawUser(user.id))?.signupGrant.blocked).toBeUndefined();
    expect(await HeldCreditRewardModel.findOne({ userId: user.id }).lean()).toMatchObject({ status: 'paused' });

    expect(await userService.unblockSignupGrant(user.id, blockAdapters)).toMatchObject({
      outcome: 'noop',
      reason: 'not_blocked',
      rewardsAffected: 1,
    });
    expect(await HeldCreditRewardModel.findOne({ userId: user.id }).lean()).toMatchObject({ status: 'held' });

    config.signupGrantTricklePoolDaily = '1000';
    expect(await creditService.releaseHeldCreditRewards(rewardAdapters, { limit: 10 })).toMatchObject({ paid: 1 });
    expect(await balance(user.id)).toBe(100);
  });
});

describe('the schedule paths while blocked, with the protection production passes', () => {
  const protectedAdapters = { ...grantAdapters, db: { ...grantAdapters.db, signupProtection: meteredProtection } };

  it('withholds a blocked pending tranche before protection runs, so the verify flow keeps its pending tag', async () => {
    const user = await makeGrantUser({ tags: [PENDING_FREE_CREDITS_TAG] });
    await userService.blockSignupGrant(user.id, blockAdapters);

    expect(await userService.releaseSignupTranche(user.id, protectedAdapters)).toMatchObject({
      creditsGranted: 0,
      withheld: true,
    });
    const release = await userService.releasePendingFreeCredits(
      { id: user.id, tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: null },
      { ...protectedAdapters, logger: { error: () => {} } }
    );
    expect(release).toMatchObject({ released: false, patch: {} });
    expect((await rawUser(user.id))?.tags).toContain(PENDING_FREE_CREDITS_TAG);
    expect(await balance(user.id)).toBe(0);
  });

  it('pays no daily drip while blocked and resumes it after unblock', async () => {
    config.signupGrantDailyCredits = '5';
    config.signupGrantDripCap = '40';
    const user = await makeGrantUser();
    await userService.releaseSignupTranche(user.id, grantAdapters);
    await userService.blockSignupGrant(user.id, blockAdapters);

    expect(await userService.dripSignupGrant(user.id, '2030-01-01', grantAdapters)).toMatchObject({
      creditsGranted: 0,
    });
    expect(await balance(user.id)).toBe(12);
    expect((await rawUser(user.id))?.signupGrant).not.toHaveProperty('lastDripDay');

    await userService.unblockSignupGrant(user.id, blockAdapters);
    expect(await userService.dripSignupGrant(user.id, '2030-01-01', grantAdapters)).toMatchObject({
      creditsGranted: 5,
    });
    expect(await balance(user.id)).toBe(17);
  });

  it('pays a due held payment unlock only after unblock', async () => {
    const user = await makeGrantUser();
    await userService.releaseSignupTranche(user.id, grantAdapters);
    const dueAt = new Date('2026-11-01T00:00:00.000Z');
    await User.collection.updateOne(
      { _id: user._id },
      { $set: { 'signupGrant.heldUnlock': { reason: 'card_verified', heldAt: dueAt, releaseAt: dueAt } } }
    );
    const releaseDue = () =>
      userService.releaseDueHeldUnlocks(
        {
          ...grantAdapters,
          listDueIds: input => signupGrantReleaseRepository.listDueHeldUnlocks(input),
          logger: { error: () => {} },
        },
        { now: new Date('2026-11-04T00:00:00.000Z'), maxUsers: 10 }
      );

    await userService.blockSignupGrant(user.id, blockAdapters);
    expect(await releaseDue()).toMatchObject({ scanned: 0, released: 0 });
    expect(await balance(user.id)).toBe(12);

    await userService.unblockSignupGrant(user.id, blockAdapters);
    expect(await releaseDue()).toMatchObject({ released: 1, creditsPaid: 28 });
    expect(await balance(user.id)).toBe(40);
  });

  it('records no payment-unlock hold while blocked, and records it after unblock', async () => {
    config.signupUnlockPaymentHoldHours = '72';
    const user = await makeGrantUser();
    await userService.releaseSignupTranche(user.id, grantAdapters);
    const cardAdapters = { ...grantAdapters, validators: { card_verified: async () => true } };
    await userService.blockSignupGrant(user.id, blockAdapters);

    expect(await userService.unlockSignupGrant(user.id, 'card_verified', cardAdapters)).toMatchObject({
      creditsGranted: 0,
    });
    expect((await rawUser(user.id))?.signupGrant).not.toHaveProperty('heldUnlock');

    await userService.unblockSignupGrant(user.id, blockAdapters);
    expect(await userService.unlockSignupGrant(user.id, 'card_verified', cardAdapters)).toMatchObject({
      withheld: true,
    });
    expect((await rawUser(user.id))?.signupGrant).toHaveProperty('heldUnlock');
  });
});

describe('admin release of a held tranche against a real database', () => {
  const heldAdapters = () => ({
    grant: {
      ...grantAdapters,
      db: { ...grantAdapters.db, signupProtection: meteredProtection },
      logger: { error: () => {} },
    },
    clearPending: (userId: string) => userRepository.clearPendingFreeCreditGrant(userId),
  });

  it('pays the tranche outside a dry pool, clears the hold and the tag, and stamps no paid standing', async () => {
    config.signupGrantSignupPoolDaily = '0';
    const user = await makeGrantUser({
      tags: [PENDING_FREE_CREDITS_TAG],
      signupGrantHeldReason: 'budget_exhausted',
      signupGrantHeldAt: new Date('2026-11-01T00:00:00.000Z'),
    });

    expect(await userService.releaseHeldSignupGrant(user.id, heldAdapters())).toEqual({
      outcome: 'applied',
      credits: 12,
    });
    expect(await balance(user.id)).toBe(12);
    const paid = await rawUser(user.id);
    expect(paid?.tags ?? []).not.toContain(PENDING_FREE_CREDITS_TAG);
    expect(paid?.signupGrantHeldReason ?? null).toBeNull();
    expect(paid?.lastCreditsPurchasedAt ?? null).toBeNull();

    expect(await userService.releaseHeldSignupGrant(user.id, heldAdapters())).toEqual({
      outcome: 'noop',
      reason: 'not_held',
    });
  });

  it('answers a tranche withheld for risk review with its reason, and pays nothing', async () => {
    const user = await makeGrantUser({
      signupGrantAssessment: {
        band: 'review',
        credits: 0,
        score: 8,
        reasons: [],
        missing: [],
        policyVersion: 'synthetic',
        status: 'evaluated',
      },
      signupGrant: { ...(await newSignupGrant(adminSettings)), stage: 'signup' },
    });

    expect(await userService.releaseHeldSignupGrant(user.id, heldAdapters())).toEqual({
      outcome: 'noop',
      reason: 'held_for_review',
    });
    expect(await userService.releaseRemainingSignupGrant(user.id, grantAdapters)).toEqual({
      outcome: 'noop',
      reason: 'held_for_review',
    });
    expect(await balance(user.id)).toBe(0);
  });
});

describe('the domain grant after a block is lifted', () => {
  const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
  const domainCredits = (id: string) =>
    CreditTransaction.countDocuments({ ownerId: id, reason: 'domain-grant signup credits' });

  it('grants credits withheld during the block once, and a repeat or a second unblock grants nothing more', async () => {
    const user = await makeGrantUser({ email: 'dee@partner.example' });
    await userService.blockSignupGrant(user.id, blockAdapters);
    await rerunDomainGrantAfterUnblock(user.id, silent);
    expect(await balance(user.id)).toBe(0);
    expect(await domainCredits(user.id)).toBe(0);

    await userService.unblockSignupGrant(user.id, blockAdapters);
    await rerunDomainGrantAfterUnblock(user.id, silent);
    expect(await balance(user.id)).toBe(250);

    await rerunDomainGrantAfterUnblock(user.id, silent);
    await userService.blockSignupGrant(user.id, blockAdapters);
    await userService.unblockSignupGrant(user.id, blockAdapters);
    await rerunDomainGrantAfterUnblock(user.id, silent);
    expect(await balance(user.id)).toBe(250);
    expect(await domainCredits(user.id)).toBe(1);
  });

  it('does not double-grant an account that already received the domain credits before the block', async () => {
    const user = await makeGrantUser({ email: 'dee@partner.example' });
    await rerunDomainGrantAfterUnblock(user.id, silent);
    expect(await balance(user.id)).toBe(250);

    await userService.blockSignupGrant(user.id, blockAdapters);
    await userService.unblockSignupGrant(user.id, blockAdapters);
    await rerunDomainGrantAfterUnblock(user.id, silent);
    expect(await balance(user.id)).toBe(250);
    expect(await domainCredits(user.id)).toBe(1);
  });
});
