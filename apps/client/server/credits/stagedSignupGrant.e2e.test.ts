import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userService } from '@bike4mind/services';
import { CURRENT_POLICY_VERSION, newSignupGrant, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import type { SignupDomainReview, SignupProtection } from '@bike4mind/common';
import {
  mongoose,
  User,
  userRepository,
  creditTransactionRepository,
  CreditTransaction,
  Quest,
  adminSettingsRepository,
  Invite,
  Organization,
  AdminSettings,
} from '@bike4mind/database';
import { unlockSignupGrantFromActivity } from './activityUnlock';
import { unlockSignupGrantFromOrgInvite } from './orgInviteUnlock';
import { checkSignupGrantEligibility } from './signupGrantEligibility';
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
  await Invite.createCollection();
  await Organization.createCollection();
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
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  await Quest.collection.deleteMany({});
  await Invite.collection.deleteMany({});
  await Organization.collection.deleteMany({});
  await AdminSettings.collection.deleteMany({});
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

function heldAdapters() {
  const review: SignupDomainReview = {
    domain: 'example.test',
    status: 'held_pending_review',
    reason: 'Generated signup burst',
    triggeredAt: new Date(),
    cohortUserIds: [],
    sampleEmails: [],
    signupCount: 5,
  };
  const findReview = vi.fn<SignupProtection['repository']['findReview']>().mockResolvedValue(review);
  const signupProtection: SignupProtection = {
    repository: {
      findReview,
      observe: async () => {},
      recent: async () => [],
      createHold: async () => false,
      isOrganizationDomain: async () => false,
    },
  };
  return {
    review,
    findReview,
    adapters: {
      ...adapters,
      db: { ...adapters.db, adminSettings: adminSettingsRepository, signupProtection },
    },
  };
}

describe('staged signup domain holds', () => {
  it('does not observe an unverified account as a verified signup', async () => {
    const user = await createUser();
    await User.updateOne({ _id: user.id }, { $set: { emailVerified: false } });
    const held = heldAdapters();
    await expect(userService.releaseSignupTranche(user.id, held.adapters)).rejects.toThrow(
      'Email verification required for signup grant'
    );
    expect(held.findReview).not.toHaveBeenCalled();
    expect(await CreditTransaction.countDocuments({})).toBe(0);
  });

  it('retains a held signup tranche and releases it exactly once after domain review', async () => {
    const user = await createUser();
    await User.updateOne({ _id: user.id }, { $set: { tags: [PENDING_FREE_CREDITS_TAG] } });
    const held = heldAdapters();
    const logger = { error: vi.fn() };
    const releaseAdapters = { ...held.adapters, logger };
    const pendingUser = { id: user.id, tags: [PENDING_FREE_CREDITS_TAG] };
    const release = await userService.releasePendingFreeCredits(pendingUser, releaseAdapters);
    expect(release).toMatchObject({ released: false, creditsGranted: 0, patch: {} });
    const persisted = await User.findById(user.id);
    expect(persisted?.tags).toContain(PENDING_FREE_CREDITS_TAG);
    expect(persisted?.signupGrant?.stage).toBe('pending_email');
    expect(persisted?.signupGrantAssessment).toBeUndefined();
    expect(persisted?.freeCreditClaimEmail).toBeUndefined();
    expect(await CreditTransaction.countDocuments({})).toBe(0);

    held.findReview.mockResolvedValue({ ...held.review, status: 'released' });
    expect(await userService.releasePendingFreeCredits(pendingUser, releaseAdapters)).toMatchObject({
      released: true,
      creditsGranted: 12,
    });
    await userRepository.clearPendingFreeCreditGrant(user.id);
    expect((await userService.releaseSignupTranche(user.id, held.adapters)).creditsGranted).toBe(0);
    expect(await CreditTransaction.countDocuments({})).toBe(1);
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
  });

  it.each(['activity', 'org_invite', 'admin', 'phone_verified', 'card_verified'] as const)(
    'blocks a held %s unlock before validators or audit side effects',
    async reason => {
      const user = await createUser();
      await userService.releaseSignupTranche(user.id, adapters);
      const held = heldAdapters();
      const validate = vi.fn(async () => true);
      const audit = vi.fn(async () => {});
      expect(
        await userService.unlockSignupGrant(user.id, reason, {
          ...held.adapters,
          validators: { [reason]: validate },
          audit,
        })
      ).toEqual({ creditsGranted: 0, currentCredits: null, withheld: true });
      expect(validate).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      const persisted = await User.findById(user.id);
      expect(persisted?.currentCredits).toBe(12);
      expect(persisted?.signupGrant?.stage).toBe('signup');
      expect(persisted?.tags ?? []).not.toContain(PENDING_FREE_CREDITS_TAG);
      expect(await CreditTransaction.countDocuments({})).toBe(1);
    }
  );

  it('keeps the pending tranche retryable when the hold lookup fails', async () => {
    const user = await createUser();
    const held = heldAdapters();
    held.findReview.mockRejectedValue(new Error('Hold store unavailable'));
    const logger = { error: vi.fn() };
    const result = await userService.releasePendingFreeCredits(
      { id: user.id, tags: [PENDING_FREE_CREDITS_TAG] },
      { ...held.adapters, logger }
    );
    expect(result).toMatchObject({ released: false, creditsGranted: 0, patch: {} });
    expect(logger.error).toHaveBeenCalled();
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    expect((await User.findById(user.id))?.signupGrant?.stage).toBe('pending_email');
  });
});

describe('staged signup ledger', () => {
  async function createAlias(email: string, signupCredits = 12) {
    return User.create({
      username: email,
      name: 'Alias user',
      email,
      emailVerified: true,
      signupGrant: { ...(await newSignupGrant(adminSettings)), signupCredits },
    });
  }

  it('shares the canonical inbox claim with legacy flat grants in either enrollment order', async () => {
    const legacy = await User.create({ username: 'legacy', name: 'Legacy', email: 'flat@gmail.com' });
    const legacyAdapters = {
      ...adapters,
      db: {
        ...adapters.db,
        adminSettings: {
          findBySettingName: async () => ({ settingValue: '12' }),
        } as unknown as typeof adminSettings,
      },
    };
    expect((await userService.grantFreeCredits({ id: legacy.id }, legacyAdapters)).creditsGranted).toBe(12);
    const stagedAlias = await createAlias('f.l.a.t+alias@googlemail.com');
    expect((await userService.releaseSignupTranche(stagedAlias.id, adapters)).creditsGranted).toBe(0);
    expect((await User.findById(stagedAlias.id))?.signupGrant?.stage).toBe('pending_email');

    const staged = await createAlias('staged@gmail.com');
    expect((await userService.releaseSignupTranche(staged.id, adapters)).creditsGranted).toBe(12);
    const flatAlias = await User.create({
      username: 'flat-alias',
      name: 'Flat alias',
      email: 's.t.a.g.e.d+alias@googlemail.com',
    });
    expect((await userService.grantFreeCredits({ id: flatAlias.id }, legacyAdapters)).creditsGranted).toBe(0);
    expect(await CreditTransaction.countDocuments({})).toBe(2);
  });

  it('allows only one staged alias payout when claims race', async () => {
    const users = await Promise.all([createAlias('race@gmail.com'), createAlias('r.a.c.e+alias@googlemail.com')]);
    // Both contenders can miss the advisory pre-check; exercise the unique-index denial,
    // which aborts the losing Mongo transaction before the repository returns false.
    vi.spyOn(User, 'exists').mockResolvedValue(null);
    const results = await Promise.all(users.map(user => userService.releaseSignupTranche(user.id, adapters)));
    expect(results.reduce((sum, result) => sum + result.creditsGranted, 0)).toBe(12);
    expect(await User.countDocuments({ freeCreditClaimEmail: 'race@gmail.com' })).toBe(1);
    expect(await CreditTransaction.countDocuments({})).toBe(1);
  });

  it('checks inbox entitlement on an unlock after a zero signup tranche', async () => {
    const denied = await createAlias('zero+denied@gmail.com', 0);
    await userService.releaseSignupTranche(denied.id, adapters);
    expect((await User.findById(denied.id))?.freeCreditClaimEmail).toBeUndefined();
    const winner = await createAlias('zero@gmail.com');
    await userService.releaseSignupTranche(winner.id, adapters);
    expect((await userService.unlockSignupGrant(denied.id, 'activity', adapters)).creditsGranted).toBe(0);
    expect((await User.findById(denied.id))?.currentCredits).toBe(0);
    const allowed = await createAlias('another@gmail.com', 0);
    await userService.releaseSignupTranche(allowed.id, adapters);
    expect((await userService.unlockSignupGrant(allowed.id, 'activity', adapters)).creditsGranted).toBe(28);
    expect((await User.findById(allowed.id))?.freeCreditClaimEmail).toBe('another@gmail.com');
  });

  it('keeps a simultaneous same-account signup payout idempotent', async () => {
    const user = await createAlias('same@gmail.com');
    const results = await Promise.all([
      userService.releaseSignupTranche(user.id, adapters),
      userService.releaseSignupTranche(user.id, adapters),
    ]);
    expect(results.reduce((sum, result) => sum + result.creditsGranted, 0)).toBe(12);
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
    expect(await CreditTransaction.countDocuments({})).toBe(1);
  });

  it('fails closed when the canonical inbox claim is unavailable', async () => {
    const user = await createAlias('unavailable@gmail.com');
    vi.spyOn(userRepository, 'claimFreeCreditGrant').mockRejectedValueOnce(new Error('claim store unavailable'));
    await expect(userService.releaseSignupTranche(user.id, adapters)).rejects.toThrow('claim store unavailable');
    expect((await User.findById(user.id))?.currentCredits).toBe(0);
    expect((await User.findById(user.id))?.signupGrant?.stage).toBe('pending_email');
    expect(await CreditTransaction.countDocuments({})).toBe(0);
  });

  it('recovers a failed organization acceptance release through persisted evidence and never mints twice', async () => {
    const user = await createUser();
    const email = 'NAME+TAG@example.test';
    await User.updateOne({ _id: user.id }, { email });
    await userService.releaseSignupTranche(user.id, adapters);
    const organization = await Organization.create({
      name: 'Synthetic organization',
      userId: 'owner',
      users: [{ userId: user.id, permissions: ['read'] }],
    });
    // A regexp-like address must not earn credits for someone else's acceptance.
    await Invite.create({
      type: 'Organization',
      documentId: organization.id,
      recipients: { pending: [], accepted: ['nameeeetag@exampleXtest'], refused: [] },
      remaining: 0,
    });
    expect((await checkSignupGrantEligibility(user.id)).creditsGranted).toBe(0);
    const acceptedInvite = await Invite.create({
      type: 'Organization',
      documentId: organization.id,
      recipients: { pending: [], accepted: [email.toLowerCase()], refused: [] },
      remaining: 0,
    });
    // Existing accepted invites cannot pay until an operator explicitly enables this source.
    expect((await unlockSignupGrantFromOrgInvite(user.id, acceptedInvite.id)).creditsGranted).toBe(0);
    expect((await checkSignupGrantEligibility(user.id)).creditsGranted).toBe(0);
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
    await AdminSettings.create({ settingName: 'signupGrantOrgInviteEnabled', settingValue: 'true' });
    const update = vi.spyOn(userRepository, 'update').mockRejectedValueOnce(new Error('temporary grant write failure'));
    await expect(unlockSignupGrantFromOrgInvite(user.id, acceptedInvite.id)).rejects.toThrow(
      'temporary grant write failure'
    );
    update.mockRestore();
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
    expect((await checkSignupGrantEligibility(user.id)).creditsGranted).toBe(28);
    expect((await checkSignupGrantEligibility(user.id)).creditsGranted).toBe(0);
    expect((await User.findById(user.id))?.currentCredits).toBe(40);
    expect(await CreditTransaction.countDocuments({ transactionId: `unlock-grant:${user.id}` })).toBe(1);
  });

  it.each(['malformed policy', 'invalid policy', 'invalid enabled policy'])(
    'holds and diagnoses %s without minting credits or exposing private inputs',
    async failure => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const user = await createUser();
      const policy =
        failure === 'malformed policy'
          ? '{invalid'
          : JSON.stringify(
              failure === 'invalid enabled policy' ? { enabled: true } : { enabled: false, unexpected: true }
            );
      const db = {
        ...adapters.db,
        adminSettings: {
          ...adminSettings,
          findBySettingName: async (name: string) =>
            name === 'signupGrantRiskPolicy'
              ? ({ settingValue: policy } as never)
              : adminSettings.findBySettingName(name),
        },
      };
      const collectRiskSignals = vi.fn(async () => {
        throw new Error('private collector failure');
      });
      expect(
        (await userService.releaseSignupTranche(user.id, { ...adapters, db, collectRiskSignals })).creditsGranted
      ).toBe(0);
      expect(collectRiskSignals).not.toHaveBeenCalled();
      const persisted = await User.findById(user.id);
      expect(persisted?.signupGrantAssessment?.status).toBe('unavailable');
      expect(persisted?.signupGrant?.stage).toBe('signup');
      expect(await CreditTransaction.countDocuments({})).toBe(0);
      expect((await userService.releaseSignupTranche(user.id, adapters)).creditsGranted).toBe(0);
      expect(warning).toHaveBeenCalledExactlyOnceWith('[signup-risk] Assessment unavailable; holding signup grant');
      expect((await userService.unlockSignupGrant(user.id, 'activity', adapters)).creditsGranted).toBe(40);
    }
  );

  it('keeps a failed observation collection retryable and grants exactly once after recovery', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const user = await createUser();
    const policy = JSON.stringify({
      enabled: true,
      version: 'retry-collector',
      rules: [{ signal: 'datacenter', comparison: 'eq', threshold: 1, weight: 2, missing: 'review', missingWeight: 0 }],
      reducedAt: 1,
      reviewAt: 3,
      reducedFraction: 0.5,
    });
    const db = {
      ...adapters.db,
      adminSettings: {
        ...adminSettings,
        findBySettingName: async (name: string) =>
          name === 'signupGrantRiskPolicy'
            ? ({ settingValue: policy } as never)
            : adminSettings.findBySettingName(name),
      },
    };
    const collectRiskSignals = vi
      .fn<() => Promise<{ datacenter: boolean }>>()
      .mockRejectedValueOnce(new Error('private collector failure'))
      .mockResolvedValue({ datacenter: false });
    const retryAdapters = { ...adapters, db, collectRiskSignals };
    await expect(userService.releaseSignupTranche(user.id, retryAdapters)).rejects.toThrow(
      'Signup risk observation collection unavailable; retry the signup grant'
    );
    const pending = await User.findById(user.id);
    expect(pending?.signupGrant?.stage).toBe('pending_email');
    expect(pending?.signupGrantAssessment).toBeUndefined();
    expect(pending?.freeCreditClaimEmail).toBeUndefined();
    expect(pending?.currentCredits).toBe(0);
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[signup-risk] Observation collection failed; signup grant remains pending for retry'
    );
    expect((await userService.releaseSignupTranche(user.id, retryAdapters)).creditsGranted).toBe(12);
    expect((await userService.releaseSignupTranche(user.id, retryAdapters)).creditsGranted).toBe(0);
    expect((await User.findById(user.id))?.signupGrantAssessment?.status).toBe('evaluated');
    expect(await CreditTransaction.countDocuments({ transactionId: `verify-grant:${user.id}` })).toBe(1);
  });

  const activitySettings = (overrides: Record<string, string | undefined> = {}) =>
    vi.spyOn(adminSettingsRepository, 'findBySettingName').mockImplementation(
      async name =>
        ({
          settingValue: (
            {
              signupGrantActivityEnabled: 'true',
              signupGrantActivityMinMessages: '2',
              signupGrantActivityDailyCredits: '10',
              signupGrantActivityMaxCredits: '28',
              ...overrides,
            } as Record<string, string | undefined>
          )[name],
        }) as never
    );
  const activityTurn = (userId: string, turnId: string, startedAt: Date, extra: Record<string, unknown> = {}) => ({
    sessionId: 'synthetic-session',
    timestamp: startedAt,
    type: 'message',
    status: 'done',
    reply: 'Completed answer',
    signupActivity: { userId, turnId, startedAt },
    ...extra,
  });

  it('drips once per qualifying UTC day from completed first-party turns, not pending or copied turns', async () => {
    const user = await createUser();
    const dayOne = new Date('2030-03-01T10:00:00Z');
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date('2030-02-01T00:00:00Z') } });
    await userService.releaseSignupTranche(user.id, adapters);
    activitySettings();
    await Quest.create([
      activityTurn(user.id, 'original', dayOne),
      activityTurn(user.id, 'original', dayOne, { sessionId: 'copy' }),
      activityTurn(user.id, 'x', dayOne, { signupActivity: undefined }),
      activityTurn(user.id, 'pending', new Date(dayOne.getTime() + 60000), { status: 'running' }),
    ]);
    expect((await unlockSignupGrantFromActivity(user.id, dayOne)).creditsGranted).toBe(0);
    await Quest.create(activityTurn(user.id, 'second', new Date(dayOne.getTime() + 120000)));
    expect((await unlockSignupGrantFromActivity(user.id, dayOne)).creditsGranted).toBe(10);
    expect((await unlockSignupGrantFromActivity(user.id, dayOne)).creditsGranted).toBe(0);
    const nextDay = new Date(dayOne.getTime() + 86400000);
    await Quest.create([
      activityTurn(user.id, 'n1', nextDay),
      activityTurn(user.id, 'n2', new Date(nextDay.getTime() + 60000)),
    ]);
    expect((await unlockSignupGrantFromActivity(user.id, nextDay)).creditsGranted).toBe(10);
  });

  it('counts a turn on the UTC day it started, so turns across midnight do not qualify one day', async () => {
    const user = await createUser();
    await userService.releaseSignupTranche(user.id, adapters);
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    activitySettings();
    await Quest.create([
      activityTurn(user.id, '0', new Date('2026-01-01T23:59:00Z')),
      activityTurn(user.id, '1', new Date('2026-01-02T00:01:00Z')),
    ]);
    expect((await unlockSignupGrantFromActivity(user.id, new Date('2026-01-01T23:59:30Z'))).creditsGranted).toBe(0);
    expect((await unlockSignupGrantFromActivity(user.id, new Date('2026-01-02T12:00:00Z'))).creditsGranted).toBe(0);
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

  it('skips signal collection for a disabled policy', async () => {
    const failingCollector = vi.fn(async () => {
      throw new Error('lookup timeout');
    });
    const user = await createUser();
    expect(
      (await userService.releaseSignupTranche(user.id, { ...adapters, collectRiskSignals: failingCollector }))
        .creditsGranted
    ).toBe(12);
    expect(failingCollector).not.toHaveBeenCalled();
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

  it('returns the persisted signup stage from a new verified OTC registration and scores it with its collector', async () => {
    const collectRiskSignals = vi.fn(async () => ({ datacenter: false }));
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
                : name === 'signupGrantRiskPolicy'
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
          registrationInvites: { findByCode: async () => null, update: async () => undefined },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
        collectRiskSignals,
      }
    );
    expect(collectRiskSignals).toHaveBeenCalledWith(expect.objectContaining({ email: 'otc@example.test' }));
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

  it('records the vouching organization on an org invite unlock so the per-org cap can count it', async () => {
    const user = await createUser();
    await userService.releaseSignupTranche(user.id, adapters);
    const result = await userService.unlockSignupGrant(user.id, 'org_invite', {
      ...adapters,
      validators: { org_invite: async () => ({ unlockedOrgId: 'org-1' }) },
    });
    expect(result.creditsGranted).toBe(28);
    expect((await User.findById(user.id))?.signupGrant).toMatchObject({
      stage: 'unlocked',
      unlockedBy: 'org_invite',
      unlockedOrgId: 'org-1',
    });
    expect(await userRepository.count({ 'signupGrant.unlockedOrgId': 'org-1' })).toBe(1);
  });

  it('rolls back ledger, balance and stage on a partial failure, then recovers on retry', async () => {
    const user = await createUser();
    const update = vi.spyOn(userRepository, 'update').mockRejectedValueOnce(new Error('synthetic write failure'));
    await expect(userService.releaseSignupTranche(user.id, adapters)).rejects.toThrow('synthetic write failure');
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    expect((await User.findById(user.id))?.currentCredits).toBe(0);
    expect((await User.findById(user.id))?.signupGrant?.stage).toBe('pending_email');
    expect((await User.findById(user.id))?.freeCreditClaimEmail).toBeUndefined();
    update.mockRestore();
    expect((await userService.releaseSignupTranche(user.id, adapters)).creditsGranted).toBe(12);
    expect((await User.findById(user.id))?.freeCreditClaimEmail).toBe('user@example.test');
  });

  it('rolls back the grant when the account update matches no user', async () => {
    const user = await createUser();
    const update = vi.spyOn(userRepository, 'update').mockResolvedValueOnce(null as never);
    await expect(userService.releaseSignupTranche(user.id, adapters)).rejects.toThrow(
      'Staged grant account update failed'
    );
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    expect((await User.findById(user.id))?.currentCredits).toBe(0);
    update.mockRestore();
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
  it('refuses to pay from a corrupt snapshot', async () => {
    const user = await createUser();
    await userService.releaseSignupTranche(user.id, adapters);
    await User.updateOne({ _id: user.id }, { 'signupGrant.creditsReleased': 41 });
    await expect(userService.unlockSignupGrant(user.id, 'activity', adapters)).rejects.toThrow(
      'Invalid staged grant amount'
    );
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
  });

  it('refuses to pay when a ledger row already exists for a stage the account has not recorded', async () => {
    const user = await createUser();
    await userService.releaseSignupTranche(user.id, adapters);
    await CreditTransaction.collection.insertOne({ transactionId: `unlock-grant:${user.id}` });
    await expect(userService.unlockSignupGrant(user.id, 'activity', adapters)).rejects.toThrow(
      'Staged grant ledger and account state disagree'
    );
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
    expect((await User.findById(user.id))?.signupGrant?.stage).toBe('signup');
  });

  it('pays nothing before the signup tranche is released or to an AI-revoked account', async () => {
    const user = await createUser();
    expect((await userService.unlockSignupGrant(user.id, 'activity', adapters)).creditsGranted).toBe(0);
    await userService.releaseSignupTranche(user.id, adapters);
    await User.updateOne({ _id: user.id }, { isModerated: true });
    expect((await userService.unlockSignupGrant(user.id, 'activity', adapters)).creditsGranted).toBe(0);
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
  });

  it.each([['false'], [undefined]])('does not unlock from activity when the flag is %s', async flag => {
    const user = await createUser();
    const at = new Date('2030-03-01T10:00:00Z');
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date('2030-02-01T00:00:00Z') } });
    await userService.releaseSignupTranche(user.id, adapters);
    activitySettings({ signupGrantActivityEnabled: flag });
    await Quest.create([activityTurn(user.id, '0', at), activityTurn(user.id, '1', new Date(at.getTime() + 60000))]);
    expect((await unlockSignupGrantFromActivity(user.id, at)).creditsGranted).toBe(0);
    expect((await User.findById(user.id))?.currentCredits).toBe(12);
  });
});
