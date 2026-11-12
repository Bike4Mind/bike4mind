import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_POLICY_VERSION, RegInviteSource, RegInviteStatusType } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import {
  AdminSettings,
  adminSettingsRepository,
  CreditTransaction,
  creditTransactionRepository,
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
} from '../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const models = [User, CreditTransaction, AdminSettings, RegistrationInvite];

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  for (const model of models) await model.createCollection();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
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
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as Parameters<typeof userService.registerViaOTC>[1];

const signUp = (username: string, inviteCode?: string) =>
  withTransaction(() =>
    userService.registerViaOTC(
      {
        username,
        email: `${username}@example.test`,
        name: username,
        password: '',
        inviteCode,
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: true,
      },
      adapters
    )
  );

const seedSettings = async (values: Record<string, string>) => {
  // Raw insert: a stored ReferralCreditsAmount row can outlive its setting definition.
  await AdminSettings.collection.insertMany(
    Object.entries({ ...values, allowOpenRegistration: 'true', ReferralCreditsAmount: '5000' }).map(
      ([settingName, settingValue]) => ({ settingName, settingValue })
    )
  );
};

const signUpReferredAndOpen = async () => {
  await RegistrationInvite.create({
    code: 'REF-PARITY',
    userId: new mongoose.Types.ObjectId().toString(),
    email: 'referred@example.test',
    source: RegInviteSource.referral,
    unlimitedUse: false,
    status: RegInviteStatusType.open,
    startingCredits: 750,
  });
  const referred = await signUp('referred', 'REF-PARITY');
  const open = await signUp('opensignup');
  return {
    referred: (await User.findById(referred.id).lean())!,
    open: (await User.findById(open.id).lean())!,
  };
};

const amounts = (user: {
  currentCredits?: number;
  signupGrant?: { signupCredits: number; unlockCredits: number };
}) => ({
  currentCredits: user.currentCredits,
  signupCredits: user.signupGrant?.signupCredits,
  unlockCredits: user.signupGrant?.unlockCredits,
});

describe('referral invitee signup grant', () => {
  it('matches an open signup under a drip cap of 0', async () => {
    await seedSettings({ signupGrantInitialCredits: '100', signupGrantDailyCredits: '0', signupGrantDripCap: '0' });
    const { referred, open } = await signUpReferredAndOpen();

    expect(referred.signupInvite).toMatchObject({ source: 'referral' });
    expect(amounts(referred)).toEqual(amounts(open));
    expect(amounts(open)).toEqual({ currentCredits: 100, signupCredits: 100, unlockCredits: 0 });
  });

  it('matches an open signup after a credit purchase unlocks the remainder', async () => {
    await seedSettings({
      signupGrantInitialCredits: '100',
      signupGrantDripCap: '400',
      signupUnlockPaymentHoldHours: '0',
    });
    const { referred, open } = await signUpReferredAndOpen();
    const unlockAdapters = { ...adapters, validators: { credit_purchase: async () => true } } as unknown as Parameters<
      typeof userService.unlockSignupGrant
    >[2];
    for (const user of [referred, open]) {
      await withTransaction(() => userService.unlockSignupGrant(String(user._id), 'credit_purchase', unlockAdapters));
    }

    const after = async (id: unknown) => (await User.findById(id).lean())!;
    const [referredAfter, openAfter] = [await after(referred._id), await after(open._id)];
    expect(amounts(referredAfter)).toEqual(amounts(openAfter));
    expect(openAfter.currentCredits).toBe(500);
  });
});
