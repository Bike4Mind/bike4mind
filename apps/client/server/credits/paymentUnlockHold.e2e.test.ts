import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userService } from '@bike4mind/services';
import { newSignupGrant, type SignupUnlockForfeitCause } from '@bike4mind/common';
import {
  mongoose,
  User,
  userRepository,
  creditTransactionRepository,
  CreditTransaction,
  adminSettingsRepository,
  AdminSettings,
  signupGrantReleaseRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const HOUR_MS = 3_600_000;
let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const config: Record<string, string | undefined> = {};
const db = {
  users: userRepository,
  creditTransactions: creditTransactionRepository,
  adminSettings: adminSettingsRepository,
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
    signupGrantDripCap: '9000',
    signupUnlockPaymentHoldHours: '72',
  });
  vi.spyOn(adminSettingsRepository, 'findBySettingName').mockImplementation(
    async name => (config[name] === undefined ? null : { settingValue: config[name] }) as never
  );
  vi.spyOn(adminSettingsRepository, 'findBySettingNames').mockImplementation(
    async names =>
      names
        .filter(name => config[name] !== undefined)
        .map(name => ({ settingName: name, settingValue: config[name] })) as never
  );
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
});

async function createSignupStageUser() {
  const user = await User.create({
    username: 'synthetic-user',
    name: 'Synthetic User',
    email: 'user@example.test',
    emailVerified: true,
    signupGrant: await newSignupGrant(adminSettingsRepository),
  });
  await userService.releaseSignupTranche(user.id, { db, reason: 'synthetic signup' });
  return user;
}

/** What invoice.payment_succeeded does through unlockSignupGrantFromSubscription. */
const subscribe = (userId: string) =>
  userService.unlockSignupGrant(userId, 'subscription', {
    db,
    reason: 'Subscribed to a paid plan',
    validators: { subscription: async user => user.emailVerified },
  });

/** What payment_intent.succeeded does through unlockSignupGrantFromCreditPurchase. */
const buyPack = (userId: string) =>
  userService.unlockSignupGrant(userId, 'credit_purchase', {
    db,
    reason: 'Bought a credit pack',
    validators: { credit_purchase: async user => user.emailVerified },
  });

/** What the hourly held-release job does. */
const runRelease = (now: Date) =>
  userService.releaseDueHeldUnlocks(
    { db, reason: 'Held signup grant released', logger, listDueIds: signupGrantReleaseRepository.listDueHeldUnlocks },
    { now, maxUsers: 100 }
  );

const forfeit = (userId: string, cause: SignupUnlockForfeitCause) =>
  userService.forfeitPaymentUnlock(userId, cause, { db });
const creditsOf = async (id: string) => (await User.findById(id))?.currentCredits ?? 0;
const grantOf = async (id: string) => (await User.findById(id))?.toObject().signupGrant;

describe('payment signup unlock hold', () => {
  it('holds the bonus on a subscription payment instead of paying it, keeping the first release time', async () => {
    const user = await createSignupStageUser();
    const before = Date.now();
    const result = await subscribe(user.id);
    expect(result).toMatchObject({ creditsGranted: 0, withheld: true });
    expect(result.heldUntil!.getTime()).toBeGreaterThanOrEqual(before + 72 * HOUR_MS);
    expect(await creditsOf(user.id)).toBe(1000);
    const held = (await grantOf(user.id))?.heldUnlock;
    expect(held).toMatchObject({ reason: 'subscription', releaseAt: result.heldUntil });
    expect(await CreditTransaction.countDocuments({ reason: 'signup_unlock:subscription' })).toBe(0);

    // A renewal or retried invoice neither pays nor moves the clock.
    expect((await subscribe(user.id)).heldUntil).toEqual(result.heldUntil);
    expect((await grantOf(user.id))?.heldUnlock?.releaseAt).toEqual(held?.releaseAt);
  });

  it('pays on the payment when the hold is set to zero hours', async () => {
    config.signupUnlockPaymentHoldHours = '0';
    const user = await createSignupStageUser();
    expect((await subscribe(user.id)).creditsGranted).toBe(9000);
    expect(await grantOf(user.id)).toMatchObject({ stage: 'unlocked', unlockedBy: 'subscription' });
  });

  it('releases the held bonus once after the settling window, not before', async () => {
    const user = await createSignupStageUser();
    const { heldUntil } = await subscribe(user.id);
    expect(await runRelease(new Date(heldUntil!.getTime() - 1000))).toMatchObject({ scanned: 0, released: 0 });
    expect(await creditsOf(user.id)).toBe(1000);

    expect(await runRelease(heldUntil!)).toMatchObject({ scanned: 1, released: 1, creditsPaid: 9000 });
    expect(await creditsOf(user.id)).toBe(10000);
    const grant = await grantOf(user.id);
    expect(grant).toMatchObject({ stage: 'unlocked', unlockedBy: 'subscription', creditsReleased: 10000 });
    expect(grant?.heldUnlock).toBeUndefined();
    expect(await runRelease(new Date(heldUntil!.getTime() + HOUR_MS))).toMatchObject({ scanned: 0 });
    expect(await CreditTransaction.countDocuments({ reason: 'signup_unlock:subscription' })).toBe(1);
  });

  it('skips a disputed account in the release scan', async () => {
    const user = await createSignupStageUser();
    const { heldUntil } = await subscribe(user.id);
    await User.updateOne({ _id: user.id }, { disputePending: true });
    expect(await runRelease(heldUntil!)).toMatchObject({ scanned: 0, released: 0 });
    expect(await creditsOf(user.id)).toBe(1000);
  });

  it.each(['dispute', 'refund', 'fraud_warning'] as const)(
    'cancels a held bonus on a %s and keeps payment unlocks closed afterwards',
    async cause => {
      const user = await createSignupStageUser();
      const { heldUntil } = await subscribe(user.id);
      expect(await forfeit(user.id, cause)).toEqual({ outcome: 'cancelled' });
      const grant = await grantOf(user.id);
      expect(grant?.heldUnlock).toBeUndefined();
      expect(grant?.unlockForfeited).toMatchObject({ cause });

      expect(await runRelease(heldUntil!)).toMatchObject({ released: 0 });
      expect(await subscribe(user.id)).toMatchObject({ creditsGranted: 0 });
      expect((await grantOf(user.id))?.heldUnlock).toBeUndefined();
      expect(await creditsOf(user.id)).toBe(1000);
      expect(await forfeit(user.id, cause)).toMatchObject({ outcome: 'already_forfeited' });
    }
  );

  it('holds a credit pack unlock and pays it once from the held-release job', async () => {
    const user = await createSignupStageUser();
    const result = await buyPack(user.id);
    expect(result).toMatchObject({ creditsGranted: 0, withheld: true });
    expect((await grantOf(user.id))?.heldUnlock).toMatchObject({ reason: 'credit_purchase' });
    expect((await buyPack(user.id)).heldUntil).toEqual(result.heldUntil);

    expect(await runRelease(result.heldUntil!)).toMatchObject({ released: 1, creditsPaid: 9000 });
    expect(await grantOf(user.id)).toMatchObject({ stage: 'unlocked', unlockedBy: 'credit_purchase' });
    expect(await CreditTransaction.countDocuments({ reason: 'signup_unlock:credit_purchase' })).toBe(1);
  });

  it('keeps the first payment hold when a credit pack follows a subscription', async () => {
    const user = await createSignupStageUser();
    const { heldUntil } = await subscribe(user.id);
    expect((await buyPack(user.id)).heldUntil).toEqual(heldUntil);
    expect((await grantOf(user.id))?.heldUnlock).toMatchObject({ reason: 'subscription', releaseAt: heldUntil });
  });

  it('cancels a held credit pack unlock on a refund', async () => {
    const user = await createSignupStageUser();
    const { heldUntil } = await buyPack(user.id);
    expect(await forfeit(user.id, 'refund')).toEqual({ outcome: 'cancelled' });
    expect(await runRelease(heldUntil!)).toMatchObject({ released: 0 });
    expect(await buyPack(user.id)).toMatchObject({ creditsGranted: 0 });
    expect(await creditsOf(user.id)).toBe(1000);
  });

  it('leaves a bonus already paid to the dispute clawback', async () => {
    config.signupUnlockPaymentHoldHours = '0';
    const user = await createSignupStageUser();
    await subscribe(user.id);
    expect(await forfeit(user.id, 'dispute')).toEqual({ outcome: 'forfeited' });
    expect((await grantOf(user.id))?.unlockForfeited).toMatchObject({ cause: 'dispute' });
    expect(await creditsOf(user.id)).toBe(10000);
  });
});
