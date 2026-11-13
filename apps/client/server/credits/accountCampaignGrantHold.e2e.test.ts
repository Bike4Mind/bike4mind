import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userService } from '@bike4mind/services';
import { newSignupGrant } from '@bike4mind/common';
import type { SignupProtection } from '@bike4mind/common';
import {
  mongoose,
  User,
  userRepository,
  creditTransactionRepository,
  CreditTransaction,
  AdminSettings,
  ShadowDetectionModel,
  shadowDetectionRepository,
} from '@bike4mind/database';
import type { RecordShadowDetectionInput } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const UNCAPPED = '1000000000';
const config: Record<string, string> = {};
const adminSettings = {
  findBySettingName: async (key: string) => (key in config ? { settingValue: config[key] } : null),
  findBySettingNames: async (keys: string[]) =>
    keys.filter(key => key in config).map(key => ({ settingName: key, settingValue: config[key] })),
} as unknown as Parameters<typeof newSignupGrant>[0] & { findBySettingNames: (keys: string[]) => Promise<unknown[]> };

const signupProtection: SignupProtection = {
  repository: {
    findReview: async () => null,
    observe: async () => {},
    recent: async () => [],
    createHold: async () => false,
    isOrganizationDomain: async () => false,
  },
  hasOpenAccountCampaign: async userId =>
    (await shadowDetectionRepository.countOpenForUser(userId, 'accountCampaign')) > 0,
};
const adapters = {
  db: { users: userRepository, creditTransactions: creditTransactionRepository, adminSettings, signupProtection },
  reason: 'synthetic signup',
  validators: {},
};
const logger = { error: vi.fn() };

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await CreditTransaction.createCollection();
  await AdminSettings.createCollection();
  await ShadowDetectionModel.createCollection();
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
    signupGrantInitialCredits: '1000',
    signupGrantDailyCredits: '1000',
    signupGrantDripCap: '9000',
    signupGrantSignupPoolDaily: UNCAPPED,
    signupGrantTricklePoolDaily: UNCAPPED,
    signupUnlockPaymentHoldHours: '0',
  });
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  await ShadowDetectionModel.deleteMany({});
});

async function createSignupStageUser() {
  const user = await User.create({
    username: 'synthetic-user',
    name: 'Synthetic User',
    email: 'user@example.test',
    emailVerified: true,
    signupGrant: await newSignupGrant(adminSettings),
  });
  await userService.releaseSignupTranche(user.id, adapters);
  return user;
}

const detect = (userIds: string[], overrides: Partial<RecordShadowDetectionInput> = {}) =>
  shadowDetectionRepository.record({
    detector: 'accountCampaign',
    policyVersion: 1,
    wouldAction: 'contain',
    summary: 'Synthetic account campaign',
    userIds,
    network: { ip: '203.0.113.7', asn: 64500, asnOrg: 'Example Cloud', country: 'US', hosting: true },
    signals: [{ key: 'campaign', label: 'Campaign signal', observed: 3, threshold: 1 }],
    windowMinutes: 180,
    group: null,
    payment: null,
    detectedAt: new Date('2030-01-01T00:00:00Z'),
    ...overrides,
  });

const grade = (id: string, verdict: 'confirmed_abuse' | 'legitimate_human') =>
  shadowDetectionRepository.addVerdict({
    id,
    expectedRevision: 0,
    verdict,
    reason: 'Checked the cohort',
    reviewerId: 'admin1',
  });

const day = (n: number) => new Date(Date.UTC(2030, 0, 1 + n)).toISOString().slice(0, 10);
const drip = (userId: string, n: number) => userService.dripSignupGrant(userId, day(n), adapters);
const unlockPhone = (userId: string) =>
  userService.unlockSignupGrant(userId, 'phone_verified', {
    ...adapters,
    validators: { phone_verified: async () => true },
  });
const creditsOf = async (id: string) => (await User.findById(id))?.currentCredits ?? 0;
const grantOf = async (id: string) => (await User.findById(id))?.toObject().signupGrant;
const HOUR_MS = 3_600_000;
const runRelease = (now = new Date()) =>
  userService.releaseDueHeldUnlocks(
    { ...adapters, logger, listDueIds: async () => (await User.find({}).lean()).map(u => String(u._id)) },
    { now, maxUsers: 100 }
  );

describe('account campaign hold on the staged signup grant', () => {
  it('pays the first tranche but withholds unlocks and drips while a detection is unreviewed', async () => {
    const user = await createSignupStageUser();
    await detect([user.id]);
    expect(await creditsOf(user.id)).toBe(1000);

    expect(await unlockPhone(user.id)).toMatchObject({ creditsGranted: 0, withheld: true });
    expect(await drip(user.id, 0)).toMatchObject({ creditsGranted: 0 });
    expect(await creditsOf(user.id)).toBe(1000);
    expect(await CreditTransaction.countDocuments({ ownerId: user.id })).toBe(1);
  });

  it('never holds the first tranche, even with a detection already recorded', async () => {
    const user = await User.create({
      username: 'synthetic-first',
      name: 'Synthetic First',
      email: 'first@example.test',
      emailVerified: true,
      signupGrant: await newSignupGrant(adminSettings),
    });
    await detect([user.id]);
    await userService.releaseSignupTranche(user.id, adapters);
    expect(await creditsOf(user.id)).toBe(1000);
  });

  it('lifts the hold when the detection is graded legitimate_human', async () => {
    const user = await createSignupStageUser();
    const id = await detect([user.id]);
    expect(await drip(user.id, 0)).toMatchObject({ creditsGranted: 0 });

    await grade(id, 'legitimate_human');
    const result = await drip(user.id, 1);
    expect(result.creditsGranted).toBeGreaterThan(0);
    expect(await creditsOf(user.id)).toBeGreaterThan(1000);
  });

  it('keeps the hold on a confirmed_abuse verdict', async () => {
    const user = await createSignupStageUser();
    await grade(await detect([user.id]), 'confirmed_abuse');
    expect(await unlockPhone(user.id)).toMatchObject({ creditsGranted: 0, withheld: true });
    expect(await drip(user.id, 0)).toMatchObject({ creditsGranted: 0 });
    expect(await creditsOf(user.id)).toBe(1000);
  });

  it('pays an admin unlock despite the hold', async () => {
    const user = await createSignupStageUser();
    await detect([user.id]);
    const audit = vi.fn(async () => {});
    const result = await userService.unlockSignupGrant(user.id, 'admin', {
      ...adapters,
      validators: { admin: async () => true },
      audit,
    });
    expect(result.creditsGranted).toBeGreaterThan(0);
    expect(audit).toHaveBeenCalledOnce();
    expect(await grantOf(user.id)).toMatchObject({ stage: 'unlocked', unlockedBy: 'admin' });
  });

  it('is not held by a detection from another detector', async () => {
    const user = await createSignupStageUser();
    await detect([user.id], { detector: 'signupNetworkBurst' });
    expect((await drip(user.id, 0)).creditsGranted).toBeGreaterThan(0);
  });

  it('is not held by a detection that names another user', async () => {
    const user = await createSignupStageUser();
    await detect(['someone-else']);
    expect((await drip(user.id, 0)).creditsGranted).toBeGreaterThan(0);
  });

  it('records a held payment unlock under the hold and pays it from the release job once graded legitimate', async () => {
    const user = await createSignupStageUser();
    const id = await detect([user.id]);
    const result = await userService.unlockSignupGrant(user.id, 'subscription', {
      ...adapters,
      reason: 'Subscribed to a paid plan',
      validators: { subscription: async u => u.emailVerified },
    });
    expect(result).toMatchObject({ creditsGranted: 0, withheld: true });
    expect((await grantOf(user.id))?.heldUnlock).toMatchObject({ reason: 'subscription' });
    expect(await creditsOf(user.id)).toBe(1000);

    expect(await runRelease()).toMatchObject({ released: 0 });
    expect(await creditsOf(user.id)).toBe(1000);

    await grade(id, 'legitimate_human');
    expect(await runRelease(new Date(Date.now() + 7 * HOUR_MS))).toMatchObject({ released: 1, creditsPaid: 9000 });
    expect(await creditsOf(user.id)).toBe(10000);
    expect(await grantOf(user.id)).toMatchObject({ stage: 'unlocked', unlockedBy: 'subscription' });
    expect(await CreditTransaction.countDocuments({ reason: 'signup_unlock:subscription' })).toBe(1);
  });

  it('pushes a campaign-held unlock out on each release run, then pays it once graded after the new time', async () => {
    const user = await createSignupStageUser();
    const id = await detect([user.id]);
    await userService.unlockSignupGrant(user.id, 'subscription', {
      ...adapters,
      reason: 'Subscribed to a paid plan',
      validators: { subscription: async u => u.emailVerified },
    });
    const now = new Date(Date.now() + HOUR_MS);

    expect(await runRelease(now)).toMatchObject({ released: 0, creditsPaid: 0 });
    const deferredTo = new Date((await grantOf(user.id))!.heldUnlock!.releaseAt);
    expect(deferredTo.getTime()).toBeGreaterThan(now.getTime());
    expect(await creditsOf(user.id)).toBe(1000);

    await grade(id, 'legitimate_human');
    expect(await runRelease(now)).toMatchObject({ released: 0, creditsPaid: 0 });
    expect(await runRelease(new Date(deferredTo.getTime() + 1))).toMatchObject({ released: 1, creditsPaid: 9000 });
    expect(await creditsOf(user.id)).toBe(10000);
  });
});
