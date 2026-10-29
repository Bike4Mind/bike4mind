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
  signupGrantReleaseRepository,
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

const txRepo = creditTransactionRepository;

const heldAdapters = {
  grant: { db: adapters.db, reason: 'synthetic release', logger: { error: vi.fn() } },
  clearPending: (id: string) => userRepository.clearPendingFreeCreditGrant(id),
};
const cron = (maxUsers = 50) =>
  userService.releaseHeldGrantsAgainstBudget(
    {
      ...heldAdapters,
      listHeldIds: async input =>
        (await signupGrantReleaseRepository.listHeld({ ...input, reason: 'budget_exhausted', payableOnly: true })).map(
          r => r.id
        ),
    },
    { maxUsers }
  );
const today = () => clock.toISOString().slice(0, 10);
const spentToday = async () => (await SignupGrantBudgetDayModel.findById(today()).lean())?.spent ?? 0;
const creditsOf = async (id: string) => (await User.findById(id))?.currentCredits ?? 0;
const ledgerRows = (id: string) => CreditTransaction.countDocuments({ transactionId: `verify-grant:${id}` });

/** Day one: budget for a single grant, so users after the first are held in creation order. */
async function holdUsers(count: number) {
  config.signupGrantDailyBudget = '12';
  clock = new Date('2030-01-01T10:00:00Z');
  const users = [];
  for (let n = 0; n < count; n++) {
    const user = await createUser(true, n);
    await userService.releaseSignupTranche(user.id, adapters);
    users.push(user);
  }
  return users;
}

describe('held signup grant release', () => {
  it('pays held grants oldest first against the new day budget, once across runs', async () => {
    const users = await holdUsers(4);
    clock = new Date('2030-01-02T00:00:01Z');
    config.signupGrantDailyBudget = '24';
    expect(await cron()).toMatchObject({ released: 2, creditsPaid: 24, stoppedOnBudget: true });
    expect(await creditsOf(users[1].id)).toBe(12);
    expect(await creditsOf(users[2].id)).toBe(12);
    expect(await creditsOf(users[3].id)).toBe(0);
    expect(await cron()).toMatchObject({ released: 0, stoppedOnBudget: true });
    expect(await ledgerRows(users[1].id)).toBe(1);
    expect((await User.findById(users[3].id))?.signupGrantHeldReason).toBe('budget_exhausted');
  });

  it('skips banned accounts without stalling the accounts behind them', async () => {
    const users = await holdUsers(3);
    await User.updateOne({ _id: users[1].id }, { isBanned: true });
    clock = new Date('2030-01-02T00:00:01Z');
    config.signupGrantDailyBudget = '12';
    expect(await cron()).toMatchObject({ released: 1, scanned: 1 });
    expect(await creditsOf(users[1].id)).toBe(0);
    expect(await creditsOf(users[2].id)).toBe(12);
  });

  it('admin release bypasses the budget, leaves one ledger row after a backfill, and revoke debits once', async () => {
    const users = await holdUsers(2);
    const held = users[1];
    const batches = signupGrantReleaseRepository;
    const out = await userService.bulkReleaseHeldGrants(
      { actorId: 'admin-1', userIds: [held.id, held.id, users[0].id] },
      { ...heldAdapters, batches }
    );
    expect(out.results).toEqual([
      { userId: held.id, outcome: 'released', credits: 12 },
      { userId: users[0].id, outcome: 'not_held', credits: 0 },
    ]);
    expect(await spentToday()).toBe(12);

    const stale = { id: held.id, tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: null };
    await userService.releasePendingFreeCredits(stale, { ...heldAdapters.grant });
    expect(await ledgerRows(held.id)).toBe(1);
    expect(await creditsOf(held.id)).toBe(12);

    const revokeAdapters = { batches, users: userRepository, creditTransactions: txRepo };
    const revoked = await userService.revokeHeldGrantRelease(
      { batchId: out.batchId, actorId: 'admin-1' },
      revokeAdapters
    );
    expect(revoked?.results).toEqual([{ userId: held.id, outcome: 'reversed', credits: 12 }]);
    expect(await creditsOf(held.id)).toBe(0);
    const again = await userService.revokeHeldGrantRelease(
      { batchId: out.batchId, actorId: 'admin-1' },
      revokeAdapters
    );
    expect(again?.results[0].outcome).toBe('already_reversed');
    expect(await creditsOf(held.id)).toBe(0);
  });

  it('refuses to reclaim credits the account already spent', async () => {
    const users = await holdUsers(2);
    const out = await userService.bulkReleaseHeldGrants(
      { actorId: 'admin-1', userIds: [users[1].id] },
      { ...heldAdapters, batches: signupGrantReleaseRepository }
    );
    await User.updateOne({ _id: users[1].id }, { currentCredits: 5 });
    const revoked = await userService.revokeHeldGrantRelease(
      { batchId: out.batchId, actorId: 'admin-1' },
      { batches: signupGrantReleaseRepository, users: userRepository, creditTransactions: txRepo }
    );
    expect(revoked?.results[0].outcome).toBe('insufficient_balance');
    expect(await creditsOf(users[1].id)).toBe(5);
    expect(
      await userService.revokeHeldGrantRelease(
        { batchId: '0'.repeat(24), actorId: 'a' },
        { batches: signupGrantReleaseRepository, users: userRepository, creditTransactions: txRepo }
      )
    ).toBeNull();
  });

  it('does not let unpayable accounts at the head of the queue starve later held users', async () => {
    const users = await holdUsers(5);
    await User.updateMany({ _id: { $in: [users[1].id, users[2].id] } }, { isBanned: true });
    clock = new Date('2030-01-02T00:00:01Z');
    config.signupGrantDailyBudget = '12';
    expect(await cron(1)).toMatchObject({ released: 1, scanned: 1 });
    expect(await creditsOf(users[3].id)).toBe(12);
  });

  it('drops the hold when the inbox grant already went to another account', async () => {
    const users = await holdUsers(2);
    vi.spyOn(userRepository, 'claimFreeCreditGrant').mockResolvedValue(false);
    const out = await userService.bulkReleaseHeldGrants(
      { actorId: 'admin-1', userIds: [users[1].id] },
      { ...heldAdapters, batches: signupGrantReleaseRepository }
    );
    expect(out.results).toEqual([{ userId: users[1].id, outcome: 'released', credits: 0 }]);
    const user = await User.findById(users[1].id);
    expect(user?.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
    expect(user?.signupGrantHeldReason ?? null).toBeNull();
    expect(await creditsOf(users[1].id)).toBe(0);
  });

  it('keeps the hold when an admin release meets a blocked or unverified account', async () => {
    const users = await holdUsers(3);
    await User.updateOne({ _id: users[1].id }, { isBanned: true });
    await User.updateOne({ _id: users[2].id }, { emailVerified: false });
    const out = await userService.bulkReleaseHeldGrants(
      { actorId: 'admin-1', userIds: [users[1].id, users[2].id] },
      { ...heldAdapters, batches: signupGrantReleaseRepository }
    );
    expect(out.results.map(r => r.outcome)).toEqual(['withheld', 'withheld']);
    const held = await User.findById(users[1].id);
    expect(held?.tags).toContain(PENDING_FREE_CREDITS_TAG);
    expect(held?.signupGrantHeldReason).toBe('budget_exhausted');
  });

  it('records no credits when the grant was already paid, so revoke cannot debit it', async () => {
    config.defaultFreeCredits = '12';
    const user = await createUser(false, 7);
    expect(await userService.grantFreeCredits(user, adapters)).toMatchObject({ creditsGranted: 12 });
    await User.updateOne(
      { _id: user.id },
      { tags: [PENDING_FREE_CREDITS_TAG], signupGrantHeldReason: 'budget_exhausted' }
    );
    const out = await userService.bulkReleaseHeldGrants(
      { actorId: 'admin-1', userIds: [user.id] },
      { ...heldAdapters, batches: signupGrantReleaseRepository }
    );
    expect(out.results).toEqual([{ userId: user.id, outcome: 'released', credits: 0 }]);
    const revoked = await userService.revokeHeldGrantRelease(
      { batchId: out.batchId, actorId: 'admin-1' },
      { batches: signupGrantReleaseRepository, users: userRepository, creditTransactions: txRepo }
    );
    expect(revoked?.results).toEqual([]);
    expect(await creditsOf(user.id)).toBe(12);
  });

  it('never drives the balance negative when credits are spent between the revoke check and the debit', async () => {
    const users = await holdUsers(2);
    const out = await userService.bulkReleaseHeldGrants(
      { actorId: 'admin-1', userIds: [users[1].id] },
      { ...heldAdapters, batches: signupGrantReleaseRepository }
    );
    await User.updateOne({ _id: users[1].id }, { currentCredits: 5 });
    const stale = {
      findById: async () => ({ currentCredits: 100 }) as never,
      incrementCredits: (...args: Parameters<typeof userRepository.incrementCredits>) =>
        userRepository.incrementCredits(...args),
      decrementCreditsFloored: (...args: Parameters<typeof userRepository.decrementCreditsFloored>) =>
        userRepository.decrementCreditsFloored(...args),
    };
    const revoked = await userService.revokeHeldGrantRelease(
      { batchId: out.batchId, actorId: 'admin-1' },
      { batches: signupGrantReleaseRepository, users: stale, creditTransactions: txRepo }
    );
    expect(revoked?.results[0].outcome).toBe('insufficient_balance');
    expect(await creditsOf(users[1].id)).toBe(5);
  });

  it('lists held grants in creation order with a cursor', async () => {
    const users = await holdUsers(4);
    const page = await signupGrantReleaseRepository.listHeld({ reason: 'budget_exhausted', limit: 2 });
    expect(page.map(r => r.id)).toEqual([users[1].id, users[2].id]);
    const next = await signupGrantReleaseRepository.listHeld({ afterId: page[1].id, limit: 2 });
    expect(next.map(r => r.id)).toEqual([users[3].id]);
  });
});
