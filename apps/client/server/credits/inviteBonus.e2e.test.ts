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
  signupGrantBudgetRepository,
  SignupGrantBudgetDayModel,
} from '@bike4mind/database';
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
const adapters = {
  db: { users: userRepository, creditTransactions: creditTransactionRepository, adminSettings, signupProtection },
  reason: 'synthetic signup',
};

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await CreditTransaction.createCollection();
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
  await SignupGrantBudgetDayModel.deleteMany({});
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, {
    signupGrantInitialCredits: '1000',
    signupGrantDailyCredits: '1000',
    signupGrantDripCap: '9000',
    signupGrantInviteBonusCredits: '2000',
    signupGrantSignupPoolDaily: UNCAPPED,
    signupGrantTricklePoolDaily: UNCAPPED,
  });
});

async function createUser(n: number, invited: boolean) {
  return User.create({
    username: `synthetic-user-${n}`,
    name: 'Synthetic User',
    email: `user${n}@example.test`,
    emailVerified: true,
    signupGrant: await newSignupGrant(adminSettings),
    ...(invited ? { signupInvite: { source: 'referral', inviteId: `invite-${n}`, at: new Date() } } : {}),
  });
}

const creditsOf = async (id: string) => (await User.findById(id))?.currentCredits ?? 0;
const bonusRows = () => CreditTransaction.countDocuments({ transactionId: /^invite-bonus:/ });
const spent = async (pool: 'signup' | 'trickle') =>
  (await SignupGrantBudgetDayModel.findById(`${pool}:2030-03-01`).lean())?.spent ?? 0;
const day = (offset: number) => new Date(clock.getTime() + offset * 86400000).toISOString().slice(0, 10);

describe('invite bonus', () => {
  it('pays the bonus with the tranche and leaves the drip and its cap unchanged', async () => {
    const invited = await createUser(1, true);
    const uninvited = await createUser(2, false);
    await userService.releaseSignupTranche(invited.id, adapters);
    await userService.releaseSignupTranche(uninvited.id, adapters);
    expect(await creditsOf(invited.id)).toBe(3000);
    expect(await creditsOf(uninvited.id)).toBe(1000);
    const grant = (await User.findById(invited.id))?.signupGrant;
    expect(grant).toMatchObject({ creditsReleased: 1000, inviteBonusPaid: 2000 });
    expect(await spent('signup')).toBe(4000);
    expect(await spent('trickle')).toBe(0);

    // Replays pay nothing more.
    await userService.releaseSignupTranche(invited.id, adapters);
    expect((await userService.payInviteBonus(invited.id, adapters)).creditsGranted).toBe(0);
    expect(await bonusRows()).toBe(1);

    for (let offset = 1; offset <= 10; offset++) {
      const a = await userService.dripSignupGrant(invited.id, day(offset), adapters);
      const b = await userService.dripSignupGrant(uninvited.id, day(offset), adapters);
      expect(a.creditsGranted).toBe(b.creditsGranted);
    }
    expect(await creditsOf(invited.id)).toBe(12000);
    expect(await creditsOf(uninvited.id)).toBe(10000);
    expect(await bonusRows()).toBe(1);
  });

  it('writes nothing when the bonus is 0', async () => {
    config.signupGrantInviteBonusCredits = '0';
    const invited = await createUser(1, true);
    await userService.releaseSignupTranche(invited.id, adapters);
    expect(await creditsOf(invited.id)).toBe(1000);
    expect((await User.findById(invited.id))?.signupGrant?.inviteBonusPaid).toBeUndefined();
    expect(await bonusRows()).toBe(0);
  });

  it('pays no bonus on a reduced tranche or to an account held for review', async () => {
    const reduced = await createUser(1, true);
    await User.updateOne(
      { _id: reduced.id },
      {
        $set: {
          signupGrantAssessment: {
            band: 'reduced',
            credits: 500,
            score: 1,
            reasons: [],
            missing: [],
            policyVersion: null,
            status: 'evaluated',
          },
        },
      }
    );
    await userService.releaseSignupTranche(reduced.id, adapters);
    expect(await creditsOf(reduced.id)).toBe(500);

    config.signupGrantInviteBonusCredits = '0';
    const held = await createUser(2, true);
    await userService.releaseSignupTranche(held.id, adapters);
    config.signupGrantInviteBonusCredits = '2000';
    await User.updateOne({ _id: held.id }, { $set: { signupGrantHeldReason: 'risk_review' } });
    expect((await userService.payInviteBonus(held.id, adapters)).creditsGranted).toBe(0);
    expect(await bonusRows()).toBe(0);
  });

  it('leaves the bonus unpaid on an exhausted signup pool and pays it on a later call', async () => {
    config.signupGrantSignupPoolDaily = '1500';
    const invited = await createUser(1, true);
    await userService.releaseSignupTranche(invited.id, adapters);
    expect(await creditsOf(invited.id)).toBe(1000);
    expect((await User.findById(invited.id))?.signupGrant?.inviteBonusPaid).toBeUndefined();
    expect(await spent('signup')).toBe(1000);

    config.signupGrantSignupPoolDaily = UNCAPPED;
    expect((await userService.payInviteBonus(invited.id, adapters)).creditsGranted).toBe(2000);
    expect(await creditsOf(invited.id)).toBe(3000);
    expect(await spent('signup')).toBe(3000);
  });

  it('pays once when calls race', async () => {
    config.signupGrantInviteBonusCredits = '0';
    const invited = await createUser(1, true);
    await userService.releaseSignupTranche(invited.id, adapters);
    config.signupGrantInviteBonusCredits = '2000';
    const results = await Promise.all([
      userService.payInviteBonus(invited.id, adapters),
      userService.payInviteBonus(invited.id, adapters),
    ]);
    expect(results.map(result => result.creditsGranted).sort()).toEqual([0, 2000]);
    expect(await creditsOf(invited.id)).toBe(3000);
    expect(await bonusRows()).toBe(1);
  });
});
