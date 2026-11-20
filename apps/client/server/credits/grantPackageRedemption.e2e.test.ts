import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_POLICY_VERSION, RegInviteStatusType } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import {
  AdminSettings,
  adminSettingsRepository,
  CreditTransaction,
  creditTransactionRepository,
  GrantPackage,
  GrantPackageDayCount,
  GrantPackageRedemption,
  grantPackageRepository,
  mongoose,
  RegistrationInvite,
  registrationInviteRepository,
  SignupGrantBudgetDayModel,
  signupGrantBudgetRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const models = [
  User,
  CreditTransaction,
  AdminSettings,
  RegistrationInvite,
  GrantPackage,
  GrantPackageRedemption,
  GrantPackageDayCount,
  SignupGrantBudgetDayModel,
];

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  for (const model of models) await model.createCollection();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
  await User.collection.createIndex(
    { freeCreditClaimEmail: 1 },
    { unique: true, partialFilterExpression: { freeCreditClaimEmail: { $type: 'string' } } }
  );
  await GrantPackageRedemption.createIndexes();
  await GrantPackageDayCount.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  for (const model of models) await model.collection.deleteMany({});
  // Pools are funded so a metered grant would record a draw rather than be held.
  await AdminSettings.insertMany([
    { settingName: 'signupGrantSignupPoolDaily', settingValue: '1000000000' },
    { settingName: 'signupGrantTricklePoolDaily', settingValue: '1000000000' },
  ]);
});

const adapters = {
  db: {
    users: userRepository,
    adminSettings: adminSettingsRepository,
    registrationInvites: registrationInviteRepository,
    creditTransactions: creditTransactionRepository,
    grantPackages: grantPackageRepository,
    // What production passes on the verify path: domain protection plus the pool budget.
    signupProtection: {
      repository: {
        findReview: async () => null,
        observe: async () => {},
        recent: async () => [],
        createHold: async () => false,
        isOrganizationDomain: async () => false,
      },
      grantBudget: { repository: signupGrantBudgetRepository },
    },
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as Parameters<typeof userService.registerViaOTC>[1];

// Same shape as the OTC verify route: an invite signup runs inside one transaction.
const signUp = (username: string, email: string) =>
  withTransaction(() =>
    userService.registerViaOTC(
      {
        username,
        email,
        name: username,
        password: '',
        inviteCode: 'PKG-CODE',
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: true,
      },
      adapters
    )
  );

async function seedPackage(
  totalCap: number,
  {
    expiresAt = null,
    credits = 100,
    legacy = false,
  }: { expiresAt?: Date | null; credits?: number; legacy?: boolean } = {}
) {
  const pkg = await GrantPackage.create({
    name: 'Synthetic package',
    credits,
    totalCap,
    dailyCap: null,
    expiresAt,
    legacy,
    createdBy: 'synthetic-admin',
  });
  await RegistrationInvite.create({
    code: 'PKG-CODE',
    userId: 'synthetic-admin',
    unlimitedUse: true,
    status: RegInviteStatusType.open,
    grantPackageId: String(pkg._id),
  });
  return String(pkg._id);
}

describe('grant package redemption through OTC registration', () => {
  it('grants the first signup and refuses the second with the cap reason', async () => {
    const packageId = await seedPackage(1);

    const first = await signUp('pkgfirst', 'first@example.test');
    expect((await User.findById(first.id).lean())?.currentCredits).toBe(100);

    await expect(signUp('pkgsecond', 'second@example.test')).rejects.toThrow(
      'This invite code has reached its signup limit'
    );
    expect(await User.countDocuments({ email: 'second@example.test' })).toBe(0);
    const pkg = await GrantPackage.findById(packageId).lean();
    expect(pkg?.redeemedTotal).toBe(1);
    expect(pkg?.capHits).toBe(1);
  });

  it('refuses a signup after the package expired and rolls the account back', async () => {
    const packageId = await seedPackage(5, { expiresAt: new Date(Date.now() - 60_000) });

    await expect(signUp('pkgexpired', 'expired@example.test')).rejects.toThrow('This invite code has expired');
    expect(await User.countDocuments({ email: 'expired@example.test' })).toBe(0);
    const pkg = await GrantPackage.findById(packageId).lean();
    expect(pkg?.redeemedTotal).toBe(0);
    expect(pkg?.capHits).toBe(0);
  });

  it('refuses an alias of an inbox that already redeemed a package grant', async () => {
    await seedPackage(5);
    await signUp('pkgowner', 'owner@gmail.com');

    await expect(signUp('pkgalias', 'owner+1@gmail.com')).rejects.toThrow(
      'This inbox has already received a signup grant'
    );
    expect(await User.countDocuments({ email: 'owner+1@gmail.com' })).toBe(0);
  });
});

// A package grant is an explicit amount: it never draws the daily signup or trickle pools, never enrolls
// the staged drip, and never confers the paid standing only a purchase stamps.
describe('grant package payout invariants', () => {
  async function expectUnmeteredUnpaid(userId: string) {
    expect(await SignupGrantBudgetDayModel.countDocuments()).toBe(0);
    const user = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
    expect(user?.signupGrant ?? null).toBeNull();
    expect(user?.signupGrantHeldReason ?? null).toBeNull();
    expect(user?.lastCreditsPurchasedAt ?? null).toBeNull();
    expect(await CreditTransaction.countDocuments({ ownerId: userId, type: 'purchase' })).toBe(0);
  }

  it('pays the package amount with no pool draw, no drip enrollment and no paid standing', async () => {
    await seedPackage(5);
    const user = await signUp('pkginvariant', 'invariant@example.test');

    expect((await User.findById(user.id).lean())?.currentCredits).toBe(100);
    expect(await CreditTransaction.countDocuments({ ownerId: user.id, type: 'generic_add', credits: 100 })).toBe(1);
    await expectUnmeteredUnpaid(user.id);
  });

  it('pays nothing for a zero-credit package and still draws no pool', async () => {
    await seedPackage(5, { credits: 0 });
    const user = await signUp('pkgzero', 'zero@example.test');

    expect((await User.findById(user.id).lean())?.currentCredits ?? 0).toBe(0);
    await expectUnmeteredUnpaid(user.id);
  });

  it('pays a legacy package through the invite amount, still outside the pools and drip', async () => {
    await seedPackage(5, { legacy: true });
    const user = await signUp('pkglegacy', 'legacy@example.test');

    expect((await User.findById(user.id).lean())?.currentCredits).toBe(100);
    await expectUnmeteredUnpaid(user.id);
  });
});
