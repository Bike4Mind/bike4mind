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
  User,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921237500_grant-packages-from-invites';

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
];

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  for (const model of models) await model.createCollection();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
  await GrantPackageRedemption.createIndexes();
  await GrantPackageDayCount.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  for (const model of models) await model.collection.deleteMany({});
});

const adapters = {
  db: {
    users: userRepository,
    adminSettings: adminSettingsRepository,
    registrationInvites: registrationInviteRepository,
    creditTransactions: creditTransactionRepository,
    grantPackages: grantPackageRepository,
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as Parameters<typeof userService.registerViaOTC>[1];

const signUp = (username: string, inviteCode: string, email = `${username}@example.test`) =>
  withTransaction(() =>
    userService.registerViaOTC(
      {
        username,
        email,
        name: username,
        password: '',
        inviteCode,
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: true,
      },
      adapters
    )
  );

describe('invites migrated to grant packages', () => {
  it('register with the same credits the invite granted before the migration', async () => {
    await RegistrationInvite.create({
      code: 'LEGACY-CODE',
      userId: 'synthetic-admin',
      unlimitedUse: true,
      status: RegInviteStatusType.open,
      startingCredits: 250,
    });

    const before = await signUp('legacybefore', 'LEGACY-CODE');
    expect((await User.findById(before.id).lean())?.currentCredits).toBe(250);

    await migration.up();
    const invite = await RegistrationInvite.findOne({ code: 'LEGACY-CODE' }).lean();
    expect(invite?.grantPackageId).toBeTruthy();

    const after = await signUp('legacyafter', 'LEGACY-CODE');
    expect((await User.findById(after.id).lean())?.currentCredits).toBe(250);
    expect(await CreditTransaction.countDocuments({ ownerId: after.id })).toBe(1);

    const pkg = await GrantPackage.findById(invite?.grantPackageId).lean();
    expect(pkg).toMatchObject({ credits: 250, totalCap: null, redeemedTotal: 1, capHits: 0 });
  });

  // Before the migration an invite's own amount was exempt from the per-inbox claim.
  it('still grants an alias of an inbox that already took a grant', async () => {
    await RegistrationInvite.create({
      code: 'LEGACY-ALIAS',
      userId: 'synthetic-admin',
      unlimitedUse: true,
      status: RegInviteStatusType.open,
      startingCredits: 250,
    });
    await migration.up();

    const first = await signUp('aliasowner', 'LEGACY-ALIAS', 'aliasowner@example.test');
    const alias = await signUp('aliasplus', 'LEGACY-ALIAS', 'aliasowner+1@example.test');

    expect((await User.findById(first.id).lean())?.currentCredits).toBe(250);
    expect((await User.findById(alias.id).lean())?.currentCredits).toBe(250);
    expect((await User.findById(alias.id).lean())?.grantPackageId ?? null).toBeNull();
  });

  it('keeps a storage-only invite on the ReferralCreditsAmount fallback', async () => {
    await AdminSettings.create({ settingName: 'ReferralCreditsAmount', settingValue: '40' });
    await RegistrationInvite.create({
      code: 'LEGACY-STORAGE',
      userId: 'synthetic-admin',
      unlimitedUse: true,
      status: RegInviteStatusType.open,
      startingStorage: 5000,
    });
    await migration.up();

    const user = await signUp('storageonly', 'LEGACY-STORAGE');
    const stored = await User.findById(user.id).lean();
    expect(stored?.currentCredits).toBe(40);
    expect(stored?.storageLimit).toBe(5000);
  });
});
