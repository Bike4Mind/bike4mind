import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userService } from '@bike4mind/services';
import {
  CURRENT_POLICY_VERSION,
  PENDING_FREE_CREDITS_TAG,
  RegInviteSource,
  RegInviteStatusType,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import {
  AdminSettings,
  adminSettingsRepository,
  mongoose,
  User,
  userRepository,
  creditTransactionRepository,
  CreditTransaction,
  RegistrationInvite,
  registrationInviteRepository,
  SignupGrantBudgetDayModel,
} from '@bike4mind/database';
import { createRegInvite } from '@server/managers/regInviteManager';
import { signupProtection } from '@bike4mind/server-utils/auth/signupProtection';
import { releaseVerifiedPendingFreeCredits } from '@server/auth/emailVerifiedGrants';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@bike4mind/server-utils/auth/signupProtection', async () => {
  const { signupGrantBudgetRepository } = await import('@bike4mind/database');
  const clock = new Date('2030-03-01T10:00:00Z');
  return {
    signupProtection: {
      repository: {
        findReview: async () => null,
        observe: async () => {},
        recent: async () => [],
        createHold: async () => false,
        isOrganizationDomain: async () => false,
      },
      grantBudget: { repository: signupGrantBudgetRepository, notify: async () => {}, now: () => clock },
    },
  };
});

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const UNCAPPED = '1000000000';
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
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  await RegistrationInvite.collection.deleteMany({});
  await SignupGrantBudgetDayModel.deleteMany({});
  await AdminSettings.collection.deleteMany({});
  await AdminSettings.collection.insertMany(
    Object.entries({
      allowOpenRegistration: 'true',
      signupGrantInitialCredits: '1000',
      signupGrantDailyCredits: '1000',
      signupGrantDripCap: '9000',
      signupGrantInviteBonusCredits: '2000',
      signupGrantSignupPoolDaily: UNCAPPED,
      signupGrantTricklePoolDaily: UNCAPPED,
    }).map(([settingName, settingValue]) => ({ settingName, settingValue }))
  );
});

// Mirrors /api/otc/verify: an invite-coded registration runs inside a transaction so a losing
// concurrent redemption rolls its account back, then releases the deferred credits after commit.
// `deferRelease: false` instead releases them inside that transaction.
async function registerViaOtcRoute(n: number, inviteCode?: string, { deferRelease = true } = {}) {
  const deferFreeCreditRelease = Boolean(inviteCode) && deferRelease;
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
          adminSettings: adminSettingsRepository,
          registrationInvites: registrationInviteRepository,
          creditTransactions: creditTransactionRepository,
        },
        logger: logger as never,
        deferFreeCreditRelease,
      }
    );
  const user = inviteCode ? await userService.refundBudgetOnFailure(() => withTransaction(register)) : await register();
  if (!deferFreeCreditRelease) return user;
  await releaseVerifiedPendingFreeCredits(
    { id: user.id, tags: user.tags, pendingCreditGrant: user.pendingCreditGrant },
    'OTC registration (email verified)',
    logger as never
  );
  return (await userRepository.findById(user.id)) ?? user;
}

async function createReferral(inviterName: string, code: string) {
  const inviter = await User.create({ username: inviterName, name: 'Inviter', email: `${inviterName}@example.test` });
  return createRegInvite({
    userId: inviter.id,
    email: 'user1@example.test',
    code,
    status: RegInviteStatusType.open,
    source: RegInviteSource.referral,
  });
}

describe('OTC registration with a refer-a-friend invite', () => {
  it('pays the signup tranche and the invite bonus after commit, like an uninvited signup pays the tranche', async () => {
    const invite = await createReferral('synthetic-inviter', 'SYNTHREFERRAL1');

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

describe('OTC registration with a refer-a-friend invite, released inside the transaction', () => {
  it('pays the signup tranche in the caller transaction and leaves the bonus to the next paying release', async () => {
    const invite = await createReferral('synthetic-inviter', 'SYNTHREFERRAL2');

    const invitee = await registerViaOtcRoute(1, invite.code, { deferRelease: false });

    const persisted = await User.findById(invitee.id).lean();
    expect(persisted?.signupGrant).toMatchObject({ stage: 'signup', creditsReleased: 1000 });
    expect(persisted?.signupGrant?.inviteBonusPaid).toBeUndefined();
    expect(persisted?.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
    expect(persisted?.currentCredits).toBe(1000);

    const drip = await userService.dripSignupGrant(invitee.id, '2030-03-01', {
      db: {
        users: userRepository,
        signupProtection,
        adminSettings: adminSettingsRepository,
        creditTransactions: creditTransactionRepository,
      },
    });
    expect(drip.creditsGranted).toBe(1000);
    const dripped = await User.findById(invitee.id).lean();
    expect(dripped?.signupGrant?.inviteBonusPaid).toBe(2000);
    expect(dripped?.currentCredits).toBe(4000);
  });
});
