import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userService } from '@bike4mind/services';
import { newSignupGrant, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import type { SignupGrantBudgetAlert, SignupProtection } from '@bike4mind/common';
import {
  mongoose,
  User,
  userRepository,
  creditTransactionRepository,
  CreditTransaction,
  Quest,
  signupGrantBudgetRepository,
  SignupGrantBudgetDayModel,
  Invite,
  Organization,
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
  signupGrantCredits: '12',
  verifiedUnlockCredits: '28',
  signupGrantDailyBudget: '0',
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
  validators: { activity: async () => true, org_invite: async () => true, card_verified: async () => true },
};

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await CreditTransaction.createCollection();
  await Quest.createCollection();
  await Invite.createCollection();
  await Organization.createCollection();
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
  await Quest.collection.deleteMany({});
  await Invite.collection.deleteMany({});
  await Organization.collection.deleteMany({});
  await AdminSettings.collection.deleteMany({});
  await SignupGrantBudgetDayModel.deleteMany({});
  config.signupGrantDailyBudget = '0';
  notify.mockClear();
  clock = new Date();
});

async function createUser(enrolled = true, n = 0) {
  return User.create({
    username: `synthetic-user-${n}`,
    name: 'Synthetic User',
    email: `user${n}@example.test`,
    emailVerified: true,
    ...(enrolled ? { signupGrant: await newSignupGrant(adminSettings) } : {}),
  });
}

const today = () => clock.toISOString().slice(0, 10);
const spentToday = async () => (await SignupGrantBudgetDayModel.findById(today()).lean())?.spent ?? 0;
const creditsOf = async (id: string) => (await User.findById(id))?.currentCredits ?? 0;

describe('signup grant daily budget', () => {
  it('pays exactly floor(budget / grant) of concurrent signups and holds the rest', async () => {
    config.signupGrantDailyBudget = '30';
    const users = await Promise.all([0, 1, 2, 3, 4, 5].map(n => createUser(true, n)));
    const results = await Promise.all(users.map(u => userService.releaseSignupTranche(u.id, adapters)));
    expect(results.filter(r => r.creditsGranted === 12)).toHaveLength(2);
    expect(results.filter(r => r.withheld)).toHaveLength(4);
    expect(await spentToday()).toBe(24);
    const held = await User.find({ signupGrantHeldReason: 'budget_exhausted' });
    expect(held).toHaveLength(4);
    expect(held.every(u => u.tags.includes(PENDING_FREE_CREDITS_TAG) && u.signupGrant?.stage === 'pending_email')).toBe(
      true
    );
    expect(await CreditTransaction.countDocuments({})).toBe(2);
  });

  it('leaves the path unchanged when the budget is 0', async () => {
    const users = await Promise.all([0, 1, 2].map(n => createUser(true, n)));
    const results = await Promise.all(users.map(u => userService.releaseSignupTranche(u.id, adapters)));
    expect(results.map(r => r.creditsGranted)).toEqual([12, 12, 12]);
    expect(await SignupGrantBudgetDayModel.countDocuments({})).toBe(0);
    expect(await User.countDocuments({ signupGrantHeldReason: 'budget_exhausted' })).toBe(0);
  });

  it('pays a held tranche once the next UTC day opens, and never twice', async () => {
    config.signupGrantDailyBudget = '12';
    clock = new Date('2030-01-01T10:00:00Z');
    const [first, second] = await Promise.all([createUser(true, 0), createUser(true, 1)]);
    await userService.releaseSignupTranche(first.id, adapters);
    expect(await userService.releaseSignupTranche(second.id, adapters)).toMatchObject({ withheld: true });
    expect(await creditsOf(second.id)).toBe(0);

    clock = new Date('2030-01-02T00:00:01Z');
    expect(await userService.releaseSignupTranche(second.id, adapters)).toMatchObject({ creditsGranted: 12 });
    expect(await userService.releaseSignupTranche(second.id, adapters)).toMatchObject({ creditsGranted: 0 });
    const persisted = await User.findById(second.id);
    expect(persisted?.signupGrantHeldReason).toBeNull();
    expect(persisted?.signupGrant?.stage).toBe('signup');
    expect(await CreditTransaction.countDocuments({ transactionId: `verify-grant:${second.id}` })).toBe(1);
    expect(await SignupGrantBudgetDayModel.findById('2030-01-02').lean()).toMatchObject({ spent: 12 });
  });

  it('lets a card unlock pay the held tranche plus remainder without drawing the budget', async () => {
    config.signupGrantDailyBudget = '12';
    const [first, second] = await Promise.all([createUser(true, 0), createUser(true, 1)]);
    await userService.releaseSignupTranche(first.id, adapters);
    await userService.releaseSignupTranche(second.id, adapters);
    const spent = await spentToday();
    const result = await userService.unlockSignupGrant(second.id, 'card_verified', adapters);
    expect(result.creditsGranted).toBe(40);
    expect(await creditsOf(second.id)).toBe(40);
    expect(await spentToday()).toBe(spent);
    const persisted = await User.findById(second.id);
    expect(persisted?.signupGrant?.stage).toBe('unlocked');
    expect(persisted?.signupGrantHeldReason).toBeNull();
    const rows = await CreditTransaction.find({ ownerId: second.id }).lean();
    expect(rows.map(row => [row.transactionId, row.credits]).sort()).toEqual([
      [`unlock-grant:${second.id}`, 28],
      [`verify-grant:${second.id}`, 12],
    ]);
  });

  it('refunds the draw when a transient retry re-reserves and the final attempt fails', async () => {
    config.signupGrantDailyBudget = '30';
    const user = await createUser(true, 0);
    const transient = Object.assign(new Error('transient'), {
      errorLabels: ['TransientTransactionError'],
      hasErrorLabel: (label: string) => label === 'TransientTransactionError',
    });
    vi.spyOn(userRepository, 'claimFreeCreditGrant')
      .mockRejectedValueOnce(transient)
      .mockRejectedValue(new Error('boom'));
    await expect(userService.releaseSignupTranche(user.id, adapters)).rejects.toThrow();
    expect(await spentToday()).toBe(0);
  });

  it('refunds a draw made inside a scope that later fails', async () => {
    config.signupGrantDailyBudget = '30';
    const user = await createUser(true, 0);
    await expect(
      userService.refundBudgetOnFailure(async () => {
        await userService.releaseSignupTranche(user.id, adapters);
        expect(await spentToday()).toBe(12);
        throw new Error('outer rollback');
      })
    ).rejects.toThrow('outer rollback');
    expect(await spentToday()).toBe(0);
  });

  it('refuses activity and org invite unlocks while the tranche is unpaid', async () => {
    config.signupGrantDailyBudget = '12';
    const [first, second] = await Promise.all([createUser(true, 0), createUser(true, 1)]);
    await userService.releaseSignupTranche(first.id, adapters);
    await userService.releaseSignupTranche(second.id, adapters);
    for (const reason of ['activity', 'org_invite'] as const) {
      expect(await userService.unlockSignupGrant(second.id, reason, adapters)).toMatchObject({ creditsGranted: 0 });
    }
    expect(await creditsOf(second.id)).toBe(0);
    expect((await User.findById(second.id))?.signupGrant?.stage).toBe('pending_email');
  });

  it('holds an unlock that exceeds the remaining budget without touching the paid tranche', async () => {
    config.signupGrantDailyBudget = '20';
    const user = await createUser(true, 0);
    await userService.releaseSignupTranche(user.id, adapters);
    expect(await userService.unlockSignupGrant(user.id, 'activity', adapters)).toMatchObject({
      creditsGranted: 0,
      withheld: true,
    });
    expect(await creditsOf(user.id)).toBe(12);
    expect(await spentToday()).toBe(12);
    expect((await User.findById(user.id))?.signupGrantHeldReason).toBeNull();
  });

  it('leaves one ledger row and one draw when the same payout is released twice', async () => {
    config.signupGrantDailyBudget = '30';
    const user = await createUser(true, 0);
    await Promise.all([
      userService.releaseSignupTranche(user.id, adapters),
      userService.releaseSignupTranche(user.id, adapters),
    ]);
    expect(await CreditTransaction.countDocuments({ transactionId: `verify-grant:${user.id}` })).toBe(1);
    expect(await spentToday()).toBe(12);
  });

  it('alerts once at 50% and once at 100%', async () => {
    config.signupGrantDailyBudget = '24';
    const users = await Promise.all([0, 1, 2, 3].map(n => createUser(true, n)));
    for (const u of users) await userService.releaseSignupTranche(u.id, adapters);
    expect(notify.mock.calls.map(([alert]) => [alert.threshold, alert.spent])).toEqual([
      [50, 12],
      [100, 24],
    ]);
  });

  it('holds an unstaged account instead of paying past the budget, and pays it later', async () => {
    config.signupGrantDailyBudget = '12';
    config.defaultFreeCredits = '12';
    clock = new Date('2030-03-01T10:00:00Z');
    const [first, second] = await Promise.all([createUser(false, 0), createUser(false, 1)]);
    expect(await userService.grantFreeCredits(first, adapters)).toMatchObject({ creditsGranted: 12 });
    expect(await userService.grantFreeCredits(second, adapters)).toMatchObject({ withheld: true, creditsGranted: 0 });
    const held = await User.findById(second.id);
    expect(held?.tags).toContain(PENDING_FREE_CREDITS_TAG);
    expect(held?.signupGrantHeldReason).toBe('budget_exhausted');

    clock = new Date('2030-03-02T00:00:01Z');
    expect(await userService.grantFreeCredits(second, adapters)).toMatchObject({ creditsGranted: 12 });
    expect((await User.findById(second.id))?.signupGrantHeldReason).toBeNull();
  });

  it('counts a reservation once per transaction id and refunds it once', async () => {
    const repo = signupGrantBudgetRepository;
    expect(await repo.reserve('2030-02-01', 'tx-1', 10, 25)).toEqual({ spent: 10, fresh: true });
    expect(await repo.reserve('2030-02-01', 'tx-1', 10, 25)).toEqual({ spent: 10, fresh: false });
    await repo.refund('2030-02-01', 'tx-1', 10);
    await repo.refund('2030-02-01', 'tx-1', 10);
    expect((await SignupGrantBudgetDayModel.findById('2030-02-01').lean())?.spent).toBe(0);
    expect(await repo.reserve('2030-02-01', 'tx-2', 30, 25)).toBeNull();
  });
});
