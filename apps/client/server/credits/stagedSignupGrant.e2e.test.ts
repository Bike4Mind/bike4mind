import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userService } from '@bike4mind/services';
import { CURRENT_POLICY_VERSION, newSignupGrant, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import {
  mongoose,
  User,
  userRepository,
  creditTransactionRepository,
  CreditTransaction,
  Quest,
  adminSettingsRepository,
} from '@bike4mind/database';
import { unlockSignupGrantFromActivity } from './activityUnlock';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const config = {
  stagedSignupGrantEnabled: 'true',
  signupGrantCredits: '12',
  verifiedUnlockCredits: '28',
};
const adminSettings = {
  findBySettingName: async (key: string) =>
    key in config ? { settingValue: config[key as keyof typeof config] } : null,
} as unknown as Parameters<typeof newSignupGrant>[0];
const adapters = {
  db: { users: userRepository, creditTransactions: creditTransactionRepository, adminSettings },
  reason: 'synthetic signup',
  validators: { activity: async () => true, org_invite: async () => true },
};

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await CreditTransaction.createCollection();
  await Quest.createCollection();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
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
});

async function createUser(enrolled = true) {
  return User.create({
    username: 'synthetic-user',
    name: 'Synthetic User',
    email: 'user@example.test',
    emailVerified: true,
    ...(enrolled ? { signupGrant: await newSignupGrant(adminSettings) } : {}),
  });
}

describe('staged signup ledger', () => {
  it('holds an unavailable risk decision without minting credits and keeps its audit private', async () => {
    const user = await createUser();
    const db = {
      ...adapters.db,
      adminSettings: {
        ...adminSettings,
        findBySettingName: async (name: string) =>
          name === 'signupGrantRiskPolicy'
            ? ({ settingValue: '{invalid' } as never)
            : adminSettings.findBySettingName(name),
      },
    };
    expect((await userService.releaseSignupTranche(user.id, { ...adapters, db })).creditsGranted).toBe(0);
    const persisted = await User.findById(user.id);
    expect(persisted?.signupGrantAssessment?.status).toBe('unavailable');
    expect(persisted?.signupGrant?.stage).toBe('signup');
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    expect((await userService.releaseSignupTranche(user.id, adapters)).creditsGranted).toBe(0);
    expect((await userService.unlockSignupGrant(user.id, 'activity', adapters)).creditsGranted).toBe(40);
  });

  it('unlocks from persisted completed session turns on distinct elapsed days, not pending or copied turns', async () => {
    const user = await createUser();
    const first = new Date(Date.now() - 3 * 86400000);
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date(first.getTime() - 86400000) } });
    await userService.releaseSignupTranche(user.id, adapters);
    vi.spyOn(adminSettingsRepository, 'findBySettingName').mockImplementation(
      async name =>
        ({
          settingValue: (
            {
              signupGrantActivityEnabled: 'true',
              signupGrantActivityMinMessages: '2',
              signupGrantActivityMinDays: '2',
            } as Record<string, string>
          )[name],
        }) as never
    );
    const turn = {
      sessionId: 'synthetic-session',
      timestamp: first,
      type: 'message',
      status: 'done',
      reply: 'Completed answer',
      signupActivity: { userId: user.id, turnId: 'original', startedAt: first },
    };
    await Quest.create([
      turn,
      { ...turn, sessionId: 'copy' },
      { ...turn, signupActivity: undefined },
      {
        ...turn,
        status: 'running',
        signupActivity: { ...turn.signupActivity, turnId: 'pending', startedAt: new Date() },
      },
    ]);
    expect((await unlockSignupGrantFromActivity(user.id)).creditsGranted).toBe(0);
    await Quest.create({
      ...turn,
      signupActivity: { ...turn.signupActivity, turnId: 'second', startedAt: new Date(first.getTime() + 86400000) },
    });
    expect((await unlockSignupGrantFromActivity(user.id)).creditsGranted).toBe(28);
    expect((await unlockSignupGrantFromActivity(user.id)).creditsGranted).toBe(0);
  });

  it('does not equate a midnight boundary with a full elapsed activity day', async () => {
    const user = await createUser();
    await userService.releaseSignupTranche(user.id, adapters);
    const first = new Date('2026-01-01T23:59:00Z');
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    vi.spyOn(adminSettingsRepository, 'findBySettingName').mockImplementation(
      async name =>
        ({
          settingValue: (
            {
              signupGrantActivityEnabled: 'true',
              signupGrantActivityMinMessages: '2',
              signupGrantActivityMinDays: '2',
            } as Record<string, string>
          )[name],
        }) as never
    );
    await Quest.create(
      [0, 120000].map((offset, index) => ({
        sessionId: 'synthetic-session',
        timestamp: first,
        type: 'message',
        status: 'done',
        reply: 'Completed answer',
        signupActivity: { userId: user.id, turnId: String(index), startedAt: new Date(first.getTime() + offset) },
      }))
    );
    expect((await unlockSignupGrantFromActivity(user.id)).creditsGranted).toBe(0);
  });

  it('pays only the delta as stronger validated identities arrive, including concurrent retries', async () => {
    const user = await createUser();
    await userService.releaseSignupTranche(user.id, adapters);
    const unlock = (target: number) =>
      userService.unlockSignupGrant(user.id, 'phone_verified', {
        ...adapters,
        validators: { phone_verified: async () => ({ cumulativeCredits: target }) },
      });
    expect((await unlock(20)).creditsGranted).toBe(8);
    const results = await Promise.all([unlock(40), unlock(30), unlock(40)]);
    expect(results.reduce((sum, result) => sum + result.creditsGranted, 0)).toBe(20);
    expect((await unlock(20)).creditsGranted).toBe(0);
    expect((await User.findById(user.id))?.currentCredits).toBe(40);
    expect((await User.findById(user.id))?.signupGrant?.creditsReleased).toBe(40);
  });

  it('commits a bounded risk decision with the tranche and later restores only the cumulative delta', async () => {
    const user = await createUser();
    const db = {
      ...adapters.db,
      adminSettings: {
        ...adminSettings,
        findBySettingName: async (name: string) =>
          name === 'signupGrantRiskPolicy'
            ? ({
                settingValue: JSON.stringify({
                  enabled: true,
                  version: 'test',
                  rules: [
                    {
                      signal: 'datacenter',
                      comparison: 'eq',
                      threshold: 1,
                      weight: 2,
                      missing: 'review',
                      missingWeight: 0,
                    },
                  ],
                  reducedAt: 1,
                  reviewAt: 3,
                  reducedFraction: 0.5,
                }),
              } as never)
            : adminSettings.findBySettingName(name),
      },
    };
    await User.updateOne({ _id: user.id }, { 'signupMeta.isDatacenter': true });
    expect((await userService.releaseSignupTranche(user.id, { ...adapters, db })).creditsGranted).toBe(6);
    expect((await User.findById(user.id))?.signupGrantAssessment?.band).toBe('reduced');
    expect((await userService.unlockSignupGrant(user.id, 'activity', adapters)).creditsGranted).toBe(34);
    expect((await User.findById(user.id))?.currentCredits).toBe(40);
  });

  it('rejects unbounded validator entitlements and banned accounts', async () => {
    const user = await createUser();
    await userService.releaseSignupTranche(user.id, adapters);
    await expect(
      userService.unlockSignupGrant(user.id, 'phone_verified', {
        ...adapters,
        validators: { phone_verified: async () => ({ cumulativeCredits: 41 }) },
      })
    ).rejects.toThrow('Invalid unlock entitlement');
    await User.updateOne({ _id: user.id }, { isBanned: true });
    expect((await userService.unlockSignupGrant(user.id, 'activity', adapters)).creditsGranted).toBe(0);
  });

  it('returns the persisted signup stage from a new verified OTC registration', async () => {
    const result = await userService.registerViaOTC(
      {
        username: 'synthetic-otc',
        name: 'Synthetic OTC',
        email: 'otc@example.test',
        password: '',
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: true,
      },
      {
        db: {
          ...adapters.db,
          adminSettings: {
            ...adminSettings,
            findBySettingName: async name =>
              name === 'allowOpenRegistration'
                ? ({ settingName: name, settingValue: 'true' } as never)
                : adminSettings.findBySettingName(name),
          },
          registrationInvites: { findByCode: async () => null, update: async () => undefined },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      }
    );
    expect(result.currentCredits).toBe(12);
    expect(result.emailVerified).toBe(true);
    expect(result.signupGrant?.stage).toBe('signup');
    expect(result.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
  });

  it('retains a pending tranche while email is unverified', async () => {
    const user = await createUser();
    await User.updateOne({ _id: user.id }, { emailVerified: false });
    await expect(userService.releaseSignupTranche(user.id, adapters)).rejects.toThrow('Email verification required');
    expect((await User.findById(user.id))?.signupGrant?.stage).toBe('pending_email');
    expect(await CreditTransaction.countDocuments({})).toBe(0);
  });

  it('completes zero-valued grants without creating money or ledger rows', async () => {
    const user = await createUser();
    await User.updateOne({ _id: user.id }, { 'signupGrant.signupCredits': 0, 'signupGrant.unlockCredits': 0 });
    expect((await userService.releaseSignupTranche(user.id, adapters)).creditsGranted).toBe(0);
    expect((await User.findById(user.id))?.signupGrant?.stage).toBe('unlocked');
    expect(await CreditTransaction.countDocuments({})).toBe(0);
  });

  it('releases only the signup tranche and makes retries no-ops', async () => {
    const user = await createUser();
    expect((await userService.releaseSignupTranche(user.id, adapters)).creditsGranted).toBe(12);
    expect((await userService.releaseSignupTranche(user.id, adapters)).creditsGranted).toBe(0);
    expect((await User.findById(user.id))?.signupGrant?.nextCondition).toBe('verification');
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
  });

  it('releases the remainder only once when different reasons race', async () => {
    const user = await createUser();
    await userService.releaseSignupTranche(user.id, adapters);
    const results = await Promise.all([
      userService.unlockSignupGrant(user.id, 'activity', adapters),
      userService.unlockSignupGrant(user.id, 'org_invite', adapters),
      userService.unlockSignupGrant(user.id, 'activity', adapters),
    ]);
    expect(results.reduce((sum, result) => sum + result.creditsGranted, 0)).toBe(28);
    expect((await User.findById(user.id))?.currentCredits).toBe(40);
    expect(await CreditTransaction.countDocuments({ transactionId: `unlock-grant:${user.id}` })).toBe(1);
    expect((await User.findById(user.id))?.signupGrant?.stage).toBe('unlocked');
  });

  it('rolls back ledger, balance and stage on a partial failure, then recovers on retry', async () => {
    const user = await createUser();
    const update = vi.spyOn(userRepository, 'update').mockRejectedValueOnce(new Error('synthetic write failure'));
    await expect(userService.releaseSignupTranche(user.id, adapters)).rejects.toThrow('synthetic write failure');
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    expect((await User.findById(user.id))?.currentCredits).toBe(0);
    expect((await User.findById(user.id))?.signupGrant?.stage).toBe('pending_email');
    update.mockRestore();
    expect((await userService.releaseSignupTranche(user.id, adapters)).creditsGranted).toBe(12);
  });

  it('does not enroll or grant existing accounts', async () => {
    const user = await createUser(false);
    await userService.releaseSignupTranche(user.id, adapters);
    await userService.unlockSignupGrant(user.id, 'activity', adapters);
    expect((await User.findById(user.id))?.signupGrant).toBeUndefined();
    expect(await CreditTransaction.countDocuments({})).toBe(0);
  });

  it('rejects missing or false evidence and admin unlocks without an audit', async () => {
    const user = await createUser();
    await userService.releaseSignupTranche(user.id, adapters);
    for (const reason of ['card_verified', 'phone_verified', 'admin'] as const) {
      expect((await userService.unlockSignupGrant(user.id, reason, adapters)).creditsGranted).toBe(0);
    }
    expect(
      (
        await userService.unlockSignupGrant(user.id, 'activity', {
          ...adapters,
          validators: { activity: async () => false },
        })
      ).creditsGranted
    ).toBe(0);
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
  });

  it('rolls back an admin unlock if its audit fails', async () => {
    const user = await createUser();
    await userService.releaseSignupTranche(user.id, adapters);
    await expect(
      userService.unlockSignupGrant(user.id, 'admin', {
        ...adapters,
        validators: { admin: async () => true },
        audit: async () => {
          throw new Error('audit unavailable');
        },
      })
    ).rejects.toThrow('audit unavailable');
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
    expect(await CreditTransaction.countDocuments({ transactionId: `unlock-grant:${user.id}` })).toBe(0);
  });
});
