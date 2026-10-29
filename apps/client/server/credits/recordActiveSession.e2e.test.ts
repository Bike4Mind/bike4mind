import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userService } from '@bike4mind/services';
import { newSignupGrant } from '@bike4mind/common';
import {
  mongoose,
  User,
  userRepository,
  creditTransactionRepository,
  CreditTransaction,
  adminSettingsRepository,
  AdminSettings,
  SignupGrantBudgetDayModel,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { recordHeartbeat } from './recordActiveSession';
import { unlockSignupGrantFromActivity } from './activityUnlock';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const config: Record<string, string | undefined> = {};
const BASE = new Date('2030-03-01T10:00:00Z').getTime();
const at = (seconds: number) => new Date(BASE + seconds * 1000);
const ping = (userId: string, seconds: number) => recordHeartbeat(userId, at(seconds));
const adapters = {
  db: {
    users: userRepository,
    creditTransactions: creditTransactionRepository,
    adminSettings: adminSettingsRepository,
  },
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
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, {
    stagedSignupGrantEnabled: 'true',
    signupGrantCredits: '1000',
    verifiedUnlockCredits: '9000',
    signupGrantDailyBudget: '0',
    signupGrantActivityEnabled: 'true',
    signupGrantActivityMinActiveSeconds: '600',
    signupGrantActivityDailyCredits: '1000',
    signupGrantActivityMaxCredits: '9000',
  });
  vi.spyOn(adminSettingsRepository, 'findBySettingName').mockImplementation(
    async name => ({ settingValue: config[name] }) as never
  );
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  await SignupGrantBudgetDayModel.deleteMany({});
});

async function createSignupStageUser(n = 0) {
  const user = await User.create({
    username: `synthetic-user-${n}`,
    name: 'Synthetic User',
    email: `user${n}@example.test`,
    emailVerified: true,
    signupGrant: await newSignupGrant(adminSettingsRepository),
  });
  await userService.releaseSignupTranche(user.id, adapters);
  return user;
}

const creditsOf = async (id: string) => (await User.findById(id))?.currentCredits ?? 0;
const dripRows = (id: string) =>
  CreditTransaction.find({ ownerId: id, transactionId: /^unlock-grant:activity:/ }).lean();
const activityOf = async (id: string) => (await User.findById(id))?.signupGrant?.activity;

/** Pings every 60s starting at `from` until `to` seconds, returning the last result. */
async function pingEvery60s(userId: string, from: number, to: number) {
  let last = await ping(userId, from);
  for (let s = from + 60; s <= to; s += 60) last = await ping(userId, s);
  return last;
}

describe('active session heartbeat', () => {
  it('credits nothing on the first ping of a day and pays nothing below the minimum', async () => {
    const user = await createSignupStageUser();
    expect(await ping(user.id, 0)).toMatchObject({ activeSeconds: 0, paidToday: false, creditsGranted: 0 });
    expect(await pingEvery60s(user.id, 60, 540)).toMatchObject({ activeSeconds: 540, paidToday: false });
    expect(await dripRows(user.id)).toHaveLength(0);
  });

  it('treats a burst of pings inside the minimum gap as no-ops with no write', async () => {
    const user = await createSignupStageUser();
    await ping(user.id, 0);
    await ping(user.id, 60);
    const before = await activityOf(user.id);
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => ping(user.id, 61 + i)));
    expect(burst.every(r => r.activeSeconds === 60)).toBe(true);
    expect(await activityOf(user.id)).toEqual(before);
    expect(await ping(user.id, 104)).toMatchObject({ activeSeconds: 60 });
    expect(await ping(user.id, 105)).toMatchObject({ activeSeconds: 105 });
  });

  it('lets only one of several simultaneous pings credit the gap', async () => {
    const user = await createSignupStageUser();
    await ping(user.id, 0);
    await Promise.all(Array.from({ length: 6 }, () => ping(user.id, 60)));
    expect((await activityOf(user.id))?.ms).toBe(60_000);
  });

  it('caps the credit of a long gap at 90 seconds', async () => {
    const user = await createSignupStageUser();
    await ping(user.id, 0);
    expect(await ping(user.id, 3600)).toMatchObject({ activeSeconds: 90 });
  });

  it('pays exactly once on the crossing ping with the activity ledger id, then stops', async () => {
    const user = await createSignupStageUser();
    const before = await creditsOf(user.id);
    const crossing = await pingEvery60s(user.id, 0, 600);
    expect(crossing).toMatchObject({ creditsGranted: 1000, paidToday: true, activeSeconds: 600 });
    expect(await creditsOf(user.id)).toBe(before + 1000);
    expect((await dripRows(user.id)).map(r => r.transactionId)).toEqual([
      `unlock-grant:activity:${user.id}:2030-03-01`,
    ]);
    expect(await ping(user.id, 660)).toMatchObject({ creditsGranted: 0, paidToday: true });
    expect((await unlockSignupGrantFromActivity(user.id, at(700))).creditsGranted).toBe(0);
    expect(await dripRows(user.id)).toHaveLength(1);
  });

  it('pays the next day again and resets accrued time at UTC midnight', async () => {
    const user = await createSignupStageUser();
    const before = await creditsOf(user.id);
    await pingEvery60s(user.id, 0, 600);
    const nextDay = 86400;
    expect(await ping(user.id, nextDay)).toMatchObject({ activeSeconds: 0, paidToday: false, creditsGranted: 0 });
    expect(await pingEvery60s(user.id, nextDay + 60, nextDay + 600)).toMatchObject({ creditsGranted: 1000 });
    expect(await creditsOf(user.id)).toBe(before + 2000);
    expect(await dripRows(user.id)).toHaveLength(2);
  });

  it('does not carry time across midnight into the new day', async () => {
    const user = await createSignupStageUser();
    const justBefore = 14 * 3600 - 30;
    await ping(user.id, justBefore - 60);
    await ping(user.id, justBefore);
    expect(await ping(user.id, justBefore + 60)).toMatchObject({ activeSeconds: 0 });
  });

  it('pays a zero-balance user', async () => {
    const user = await createSignupStageUser();
    await User.updateOne({ _id: user.id }, { currentCredits: 0 });
    expect(await pingEvery60s(user.id, 0, 600)).toMatchObject({ creditsGranted: 1000, paidToday: true });
    expect(await creditsOf(user.id)).toBe(1000);
  });

  it('does nothing for a user without a grant or before the tranche is released, and when the flag is off', async () => {
    const plain = await User.create({ username: 'plain', name: 'Plain', email: 'plain@example.test' });
    expect(await ping(plain.id, 0)).toMatchObject({ activeSeconds: 0 });
    expect((await User.findById(plain.id))?.signupGrant).toBeUndefined();
    const user = await createSignupStageUser(1);
    config.signupGrantActivityEnabled = 'false';
    await ping(user.id, 0);
    await ping(user.id, 60);
    expect(await activityOf(user.id)).toBeUndefined();
  });

  it('withholds on an exhausted daily budget, keeps the day unpaid, and pays on a later ping once budget returns', async () => {
    const first = await createSignupStageUser(0);
    const second = await createSignupStageUser(1);
    config.signupGrantDailyBudget = '1500';
    expect(await pingEvery60s(first.id, 0, 600)).toMatchObject({ creditsGranted: 1000 });
    const blocked = await pingEvery60s(second.id, 0, 600);
    expect(blocked).toMatchObject({ creditsGranted: 0, paidToday: false, withheld: true });
    expect(await dripRows(second.id)).toHaveLength(0);
    config.signupGrantDailyBudget = '5000';
    expect(await ping(second.id, 660)).toMatchObject({ creditsGranted: 1000, paidToday: true });
  });

  it('withholds while a held signup tranche exists, then pays on retry', async () => {
    const user = await createSignupStageUser(0);
    const held = await User.create({
      username: 'held',
      name: 'Held',
      email: 'held@example.test',
      signupGrantHeldReason: 'budget_exhausted',
      signupGrantHeldAt: at(0),
      signupGrant: { ...(await newSignupGrant(adminSettingsRepository)), stage: 'pending_email' },
    });
    expect(await pingEvery60s(user.id, 0, 600)).toMatchObject({ creditsGranted: 0, withheld: true });
    await User.updateOne({ _id: held.id }, { $unset: { signupGrantHeldReason: 1 } });
    expect(await ping(user.id, 660)).toMatchObject({ creditsGranted: 1000, paidToday: true });
  });

  it('accrues nothing at the lifetime cap and resumes once the cap rises', async () => {
    const user = await createSignupStageUser();
    config.signupGrantActivityMaxCredits = '1000';
    await User.updateOne({ _id: user.id }, { 'signupGrant.dripCredits': 1000 });
    expect(await pingEvery60s(user.id, 0, 600)).toMatchObject({ creditsGranted: 0, activeSeconds: 0 });
    expect(await activityOf(user.id)).toBeUndefined();
    config.signupGrantActivityMaxCredits = '9000';
    expect(await pingEvery60s(user.id, 660, 1260)).toMatchObject({ creditsGranted: 1000, paidToday: true });
  });
});
