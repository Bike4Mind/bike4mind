import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userService } from '@bike4mind/services';
import {
  CURRENT_POLICY_VERSION,
  PENDING_FREE_CREDITS_TAG,
  RegInviteSource,
  RegInviteStatusType,
} from '@bike4mind/common';
import type { SignupProtection } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import {
  mongoose,
  User,
  userRepository,
  creditTransactionRepository,
  CreditTransaction,
  RegistrationInvite,
  registrationInviteRepository,
  signupGrantBudgetRepository,
  SignupGrantBudgetDayModel,
} from '@bike4mind/database';
import { createRegInvite } from '@server/managers/regInviteManager';
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
};
const clock = new Date('2030-03-01T10:00:00Z');
const signupProtection: SignupProtection = {
  repository: {
    findReview: async () => null,
    observe: async () => {},
    recent: async () => [],
    createHold: async () => false,
    isOrganizationDomain: async () => false,
  },
  grantBudget: { repository: signupGrantBudgetRepository, notify: async () => {}, now: () => clock },
};
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await CreditTransaction.createCollection();
  await RegistrationInvite.createCollection();
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
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  await RegistrationInvite.collection.deleteMany({});
  await SignupGrantBudgetDayModel.deleteMany({});
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, {
    allowOpenRegistration: 'true',
    signupGrantInitialCredits: '1000',
    signupGrantDailyCredits: '1000',
    signupGrantDripCap: '9000',
    signupGrantInviteBonusCredits: '2000',
    signupGrantSignupPoolDaily: UNCAPPED,
    signupGrantTricklePoolDaily: UNCAPPED,
  });
});

// Mirrors /api/otc/verify: an invite-coded registration runs inside a transaction so a losing
// concurrent redemption rolls its account back.
function registerViaOtcRoute(n: number, inviteCode?: string) {
  const register = () =>
    userService.registerViaOTC(
      {
        username: `synthetic-user-${n}`,
        email: `user${n}@example.test`,
        name: `synthetic-user-${n}`,
        password: '',
        inviteCode,
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: true,
      },
      {
        db: {
          users: userRepository,
          signupProtection,
          adminSettings: adminSettings as never,
          registrationInvites: registrationInviteRepository,
          creditTransactions: creditTransactionRepository,
        },
        logger: logger as never,
      }
    );
  return inviteCode ? userService.refundBudgetOnFailure(() => withTransaction(register)) : register();
}

describe('OTC registration with a refer-a-friend invite', () => {
  it('pays the signup tranche and the invite bonus, like an uninvited signup pays the tranche', async () => {
    const inviter = await User.create({
      username: 'synthetic-inviter',
      name: 'Inviter',
      email: 'inviter@example.test',
    });
    const invite = await createRegInvite({
      userId: inviter.id,
      email: 'user1@example.test',
      code: 'SYNTHREFERRAL1',
      status: RegInviteStatusType.open,
      source: RegInviteSource.referral,
    });

    const invitee = await registerViaOtcRoute(1, invite.code);
    const uninvited = await registerViaOtcRoute(2);

    const persisted = await User.findById(invitee.id).lean();
    expect(persisted?.signupInvite).toMatchObject({ source: 'referral', inviteId: invite.id });
    expect(persisted?.signupGrant).toMatchObject({ stage: 'signup', creditsReleased: 1000, inviteBonusPaid: 2000 });
    expect(persisted?.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
    expect(persisted?.currentCredits).toBe(3000);
    expect(invitee.currentCredits).toBe(3000);
    expect(await CreditTransaction.countDocuments({ transactionId: `invite-bonus:${invitee.id}` })).toBe(1);
    expect((await User.findById(uninvited.id).lean())?.currentCredits).toBe(1000);
  });
});
