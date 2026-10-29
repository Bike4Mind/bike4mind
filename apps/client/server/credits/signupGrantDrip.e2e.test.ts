import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userService } from '@bike4mind/services';
import { newSignupGrant } from '@bike4mind/common';
import type { SignupGrantBudgetAlert, SignupProtection } from '@bike4mind/common';
import {
  mongoose,
  User,
  userRepository,
  creditTransactionRepository,
  CreditTransaction,
  signupGrantBudgetRepository,
  SignupGrantBudgetDayModel,
  AdminSettings,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const config: Record<string, string> = {
  stagedSignupGrantEnabled: 'true',
  signupGrantCredits: '1000',
  verifiedUnlockCredits: '9000',
  signupGrantDailyBudget: '0',
  signupGrantActivityDailyCredits: '1000',
  signupGrantActivityMaxCredits: '9000',
};
const adminSettings = {
  findBySettingName: async (key: string) => (key in config ? { settingValue: config[key] } : null),
  findBySettingNames: async () => [],
} as unknown as Parameters<typeof newSignupGrant>[0] & { findBySettingNames: () => Promise<[]> };
let clock = new Date();
const notify = vi.fn<(alert: SignupGrantBudgetAlert) => Promise<void>>().mockResolvedValue();
const signupProtection: SignupProtection = {
  repository: {
    findReview: async () => null,
    observe: async () => {},
    recent: async () => [],
    createHold: async () => false,
    isOrganizationDomain: async () => false,
  },
  grantBudget: { repository: signupGrantBudgetRepository, notify, now: () => clock },
};
const adapters = {
  db: { users: userRepository, creditTransactions: creditTransactionRepository, adminSettings, signupProtection },
  reason: 'synthetic signup',
  validators: {},
};

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await CreditTransaction.createCollection();
  await AdminSettings.createCollection();
  await SignupGrantBudgetDayModel.createCollection();
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
  vi.restoreAllMocks();
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  await AdminSettings.collection.deleteMany({});
  await SignupGrantBudgetDayModel.deleteMany({});
  config.signupGrantDailyBudget = '0';
  config.signupGrantActivityDailyCredits = '1000';
  config.signupGrantActivityMaxCredits = '9000';
  notify.mockClear();
  clock = new Date();
});

async function createSignupStageUser(n = 0) {
  const user = await createUser(n);
  await userService.releaseSignupTranche(user.id, adapters);
  return user;
}

async function createUser(n = 0) {
  return User.create({
    username: `synthetic-user-${n}`,
    name: 'Synthetic User',
    email: `user${n}@example.test`,
    emailVerified: true,
    signupGrant: await newSignupGrant(adminSettings),
  });
}

const today = () => clock.toISOString().slice(0, 10);
const spentToday = async () => (await SignupGrantBudgetDayModel.findById(today()).lean())?.spent ?? 0;
const creditsOf = async (id: string) => (await User.findById(id))?.currentCredits ?? 0;

const day = (n: number) => new Date(Date.UTC(2030, 0, 1 + n)).toISOString().slice(0, 10);
const drip = (userId: string, n: number) => userService.dripSignupGrant(userId, day(n), adapters);
const dripRows = (userId: string) =>
  CreditTransaction.find({ ownerId: userId, transactionId: /^unlock-grant:activity:/ }).lean();

describe('signup activity drip', () => {
  it('releases 1000 a day for 9 days after the 1000 tranche and stops at the full 10000', async () => {
    const user = await createSignupStageUser();
    expect(await creditsOf(user.id)).toBe(1000);
    for (let n = 0; n < 9; n++) {
      clock = new Date(`${day(n)}T12:00:00Z`);
      expect(await drip(user.id, n)).toMatchObject({ creditsGranted: 1000 });
      expect(await creditsOf(user.id)).toBe(2000 + n * 1000);
    }
    const persisted = await User.findById(user.id);
    expect(persisted?.signupGrant).toMatchObject({
      stage: 'unlocked',
      creditsReleased: 10000,
      dripCredits: 9000,
      lastDripDay: day(8),
      unlockedBy: 'activity_drip',
    });
    expect((await dripRows(user.id)).map(row => row.transactionId).sort()).toEqual(
      Array.from({ length: 9 }, (_, n) => `unlock-grant:activity:${user.id}:${day(n)}`)
    );
    expect(await drip(user.id, 9)).toMatchObject({ creditsGranted: 0 });
    expect(await creditsOf(user.id)).toBe(10000);
  });

  it('grants nothing on a same-day rerun and exactly once under concurrent turns', async () => {
    const user = await createSignupStageUser();
    expect(await drip(user.id, 0)).toMatchObject({ creditsGranted: 1000 });
    expect(await drip(user.id, 0)).toMatchObject({ creditsGranted: 0 });
    const results = await Promise.all([drip(user.id, 1), drip(user.id, 1), drip(user.id, 1)]);
    expect(results.filter(r => r.creditsGranted === 1000)).toHaveLength(1);
    expect(await creditsOf(user.id)).toBe(3000);
    expect(await dripRows(user.id)).toHaveLength(2);
  });

  it('never pays past the configured cap', async () => {
    config.signupGrantActivityMaxCredits = '2500';
    const user = await createSignupStageUser();
    const granted: number[] = [];
    for (let n = 0; n < 5; n++) granted.push((await drip(user.id, n)).creditsGranted);
    expect(granted).toEqual([1000, 1000, 500, 0, 0]);
    expect(await creditsOf(user.id)).toBe(3500);
  });

  it.each([
    ['daily rate', 'signupGrantActivityDailyCredits'],
    ['cap', 'signupGrantActivityMaxCredits'],
  ])('is off when the %s is 0 or invalid', async (_label, key) => {
    const user = await createSignupStageUser();
    for (const value of ['0', '-5', 'abc']) {
      config[key] = value;
      expect(await drip(user.id, 0)).toMatchObject({ creditsGranted: 0 });
    }
    expect(await dripRows(user.id)).toHaveLength(0);
  });

  it('draws the daily budget, and an exhausted budget pays nothing and retries on a later day', async () => {
    const first = await createSignupStageUser(0);
    const second = await createSignupStageUser(1);
    config.signupGrantDailyBudget = '1500';
    clock = new Date(`${day(0)}T09:00:00Z`);
    expect(await drip(first.id, 0)).toMatchObject({ creditsGranted: 1000 });
    expect(await spentToday()).toBe(1000);
    expect(await drip(second.id, 0)).toMatchObject({ creditsGranted: 0, withheld: true });
    expect(await dripRows(second.id)).toHaveLength(0);
    expect((await User.findById(second.id))?.signupGrant?.dripCredits).toBeUndefined();
    expect(await spentToday()).toBe(1000);

    clock = new Date(`${day(1)}T09:00:00Z`);
    expect(await drip(second.id, 1)).toMatchObject({ creditsGranted: 1000 });
    expect(await spentToday()).toBe(1000);
  });

  it('pays held signup tranches before any drip', async () => {
    const dripper = await createSignupStageUser(0);
    config.signupGrantDailyBudget = '1000';
    clock = new Date(`${day(0)}T09:00:00Z`);
    await userService.releaseSignupTranche((await createUser(2)).id, adapters);
    const held = await createUser(1);
    expect(await userService.releaseSignupTranche(held.id, adapters)).toMatchObject({ withheld: true });
    expect(await drip(dripper.id, 0)).toMatchObject({ creditsGranted: 0, withheld: true });
    expect(await dripRows(dripper.id)).toHaveLength(0);

    clock = new Date(`${day(1)}T09:00:00Z`);
    expect(await userService.releaseSignupTranche(held.id, adapters)).toMatchObject({ creditsGranted: 1000 });
    clock = new Date(`${day(2)}T09:00:00Z`);
    expect(await drip(dripper.id, 2)).toMatchObject({ creditsGranted: 1000 });
  });

  it('skips accounts with a pending tranche or no staged grant', async () => {
    const pending = await createUser(0);
    expect(await drip(pending.id, 0)).toMatchObject({ creditsGranted: 0 });
    const legacy = await User.create({
      username: 'legacy',
      name: 'Legacy',
      email: 'legacy@example.test',
      emailVerified: true,
    });
    expect(await drip(legacy.id, 0)).toMatchObject({ creditsGranted: 0 });
    expect(await CreditTransaction.countDocuments({})).toBe(0);
  });

  it('hands a failed payout back to the budget', async () => {
    const user = await createSignupStageUser();
    config.signupGrantDailyBudget = '1000';
    clock = new Date(`${day(0)}T09:00:00Z`);
    vi.spyOn(userRepository, 'update').mockRejectedValueOnce(new Error('write failed'));
    await expect(drip(user.id, 0)).rejects.toThrow('write failed');
    expect(await spentToday()).toBe(0);
    expect(await drip(user.id, 0)).toMatchObject({ creditsGranted: 1000 });
  });

  it('releases the full remainder on a subscription outside an exhausted budget, once', async () => {
    config.signupGrantDailyBudget = '1000';
    const user = await createSignupStageUser(0);
    const spent = await spentToday();
    expect(spent).toBe(1000);
    const subscribe = () =>
      userService.unlockSignupGrant(user.id, 'subscription', {
        ...adapters,
        validators: { subscription: async current => current.emailVerified },
      });
    expect((await subscribe()).creditsGranted).toBe(9000);
    expect(await creditsOf(user.id)).toBe(10000);
    expect(await spentToday()).toBe(spent);
    expect((await User.findById(user.id))?.signupGrant?.stage).toBe('unlocked');
    expect((await subscribe()).creditsGranted).toBe(0);
  });

  it('pays a budget-held tranche first when the account subscribes', async () => {
    config.signupGrantDailyBudget = '1000';
    await createSignupStageUser(0);
    const held = await createUser(1);
    await userService.releaseSignupTranche(held.id, adapters);
    expect((await User.findById(held.id))?.signupGrantHeldReason).toBe('budget_exhausted');
    const result = await userService.unlockSignupGrant(held.id, 'subscription', {
      ...adapters,
      validators: { subscription: async current => current.emailVerified },
    });
    expect(result.creditsGranted).toBe(10000);
    expect(await spentToday()).toBe(1000);
  });
});
