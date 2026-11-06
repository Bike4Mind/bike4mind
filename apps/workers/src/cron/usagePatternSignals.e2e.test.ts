import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { CreditHolderType } from '@bike4mind/common';
import {
  ApiKeyUsageLog,
  Cache,
  CreditTransaction,
  ShadowDetectionModel,
  UsageEvent,
  User,
  UserApiKey,
  UserUsagePatternSignals,
  userUsagePatternSignalsRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

const h = vi.hoisted(() => ({
  getSettingsMap: vi.fn(),
  getActiveSubscriptionsForUser: vi.fn(),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: h.getSettingsMap,
}));
vi.mock('@server/entitlements/activeSubscriptions', () => ({
  getActiveSubscriptionsForUser: h.getActiveSubscriptionsForUser,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import { CREDIT_BALANCE_ENDPOINT, runUsagePatternSignals } from './usagePatternSignals';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const now = new Date('2026-01-10T12:00:00Z');
const MINUTE = 60_000;
// Sample values for the test only.
const sampleConfig = {
  reviewThreshold: 60,
  apiOnlyMinRequests: 10,
  cadenceSampleSize: 20,
  cadenceMaxVariation: 0.15,
  creditPollMinCount: 10,
  creditPollMinPerCompletion: 1,
  quickApiKeyMinutes: 15,
  weights: { scriptedGrantDrain: 60 },
};

let server: Awaited<ReturnType<typeof createMongoServer>>;

async function seedUser(fields: Record<string, unknown> = {}) {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    email: `${_id}@example.test`,
    username: `u${_id}`,
    isAdmin: false,
    isBanned: false,
    lastCreditsPurchasedAt: null,
    emailVerifiedAt: new Date(now.getTime() - 2 * 24 * 60 * MINUTE),
    ...fields,
  });
  return String(_id);
}

async function seedUsage(userId: string, times: Date[], fields: Record<string, unknown>) {
  await UsageEvent.collection.insertMany(
    times.map((createdAt, i) => ({
      userId,
      requestId: `${userId}-${i}`,
      ownerType: CreditHolderType.User,
      createdAt,
      ...fields,
    }))
  );
}

async function seedCreditPolls(userId: string, count: number) {
  await ApiKeyUsageLog.collection.insertMany(
    Array.from({ length: count }, (_, i) => ({
      keyId: 'k',
      userId,
      timestamp: new Date(now.getTime() - (i + 1) * 5 * MINUTE),
      endpoint: CREDIT_BALANCE_ENDPOINT,
      method: 'GET',
      ipAddress: '192.0.2.1',
      responseTime: 10,
      statusCode: 200,
    }))
  );
}

/** Synthetic high-signal account: steady API-only calls, heavy polling, key minted right after verification. */
async function seedHighSignalUser(fields: Record<string, unknown> = {}) {
  const userId = await seedUser(fields);
  const verifiedAt = (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) }))!.emailVerifiedAt;
  await UserApiKey.collection.insertOne({
    userId,
    keyPrefix: userId,
    name: 'k',
    createdAt: new Date(verifiedAt.getTime() + 3 * MINUTE),
  });
  const times = Array.from({ length: 40 }, (_, i) => new Date(now.getTime() - (i + 1) * 2 * MINUTE - (i % 2) * 2000));
  await seedUsage(userId, times, { apiKeyId: 'k', source: 'api' });
  await seedCreditPolls(userId, 60);
  return userId;
}

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(async () => {
  await Promise.all(
    [
      User,
      UserApiKey,
      UsageEvent,
      ApiKeyUsageLog,
      UserUsagePatternSignals,
      CreditTransaction,
      ShadowDetectionModel,
      Cache,
    ].map(m => (m as unknown as mongoose.Model<unknown>).collection.deleteMany({}))
  );
  vi.clearAllMocks();
  h.getActiveSubscriptionsForUser.mockResolvedValue([]);
  h.getSettingsMap.mockResolvedValue({
    usagePatternSignalsEnabled: 'true',
    usagePatternSignalsConfig: JSON.stringify(sampleConfig),
  });
});

describe('runUsagePatternSignals', () => {
  it('does nothing while the switch is off (the default)', async () => {
    h.getSettingsMap.mockResolvedValue({});
    await seedHighSignalUser();

    expect(await runUsagePatternSignals({ now })).toMatchObject({ status: 'disabled', analyzed: 0 });
    expect(await UserUsagePatternSignals.countDocuments()).toBe(0);
  });

  it('flags a high-signal free-tier account and not a typical one', async () => {
    const highSignal = await seedHighSignalUser();
    await UsageEvent.collection.insertMany([
      {
        userId: highSignal,
        feature: 'operations',
        requestId: 'session-1',
        ownerType: CreditHolderType.User,
        createdAt: new Date(now.getTime() - MINUTE),
      },
    ]);
    const typical = await seedUser();
    const gapsMinutes = [3, 47, 1, 220, 9, 15, 600, 2, 75, 30, 4, 180, 12, 6, 95, 1, 40, 8, 300, 20, 5];
    let at = now.getTime();
    await seedUsage(
      typical,
      gapsMinutes.map(g => new Date((at -= g * MINUTE))),
      { source: 'web' }
    );

    const result = await runUsagePatternSignals({ now });

    expect(result).toMatchObject({ status: 'success', analyzed: 2, needsReview: 1, errors: 0 });
    const flagged = await userUsagePatternSignalsRepository.findByUserId(highSignal);
    expect(flagged).toMatchObject({ score: 100, needsReview: true, computedAt: now });
    expect(flagged?.signals.map(s => [s.id, s.triggered])).toEqual([
      ['apiOnlyUsage', true],
      ['regularCadence', true],
      ['creditPolling', true],
      ['quickApiKey', true],
      ['scriptedGrantDrain', false],
    ]);
    const normal = await userUsagePatternSignalsRepository.findByUserId(typical);
    expect(normal).toMatchObject({ score: 0, needsReview: false });
  });

  it('skips paid, admin, approved and inactive accounts', async () => {
    const paid = await seedHighSignalUser();
    await seedHighSignalUser({ isAdmin: true });
    await seedHighSignalUser({ apiKeyTrustApproved: true });
    await seedHighSignalUser({ lastCreditsPurchasedAt: new Date('2025-12-01T00:00:00Z') });
    const quiet = await seedUser();
    await seedUsage(quiet, [new Date(now.getTime() - 5 * 24 * 60 * MINUTE)], { apiKeyId: 'k', source: 'api' });
    h.getActiveSubscriptionsForUser.mockImplementation(async (userId: string) => (userId === paid ? [{}] : []));

    const result = await runUsagePatternSignals({ now });

    expect(result).toMatchObject({ analyzed: 0, skippedPaid: 1 });
    expect(await UserUsagePatternSignals.find({}, { _id: 0, userId: 1, skipped: 1, needsReview: 1 }).lean()).toEqual([
      { userId: paid, skipped: 'paid', needsReview: false },
    ]);
  });

  it('keeps one result per user across runs and leaves the account untouched', async () => {
    const highSignal = await seedHighSignalUser();
    const before = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(highSignal) });

    await runUsagePatternSignals({ now });
    await runUsagePatternSignals({ now: new Date(now.getTime() + 60 * MINUTE) });

    expect(await UserUsagePatternSignals.countDocuments({ userId: highSignal })).toBe(1);
    expect(await User.collection.findOne({ _id: new mongoose.Types.ObjectId(highSignal) })).toEqual(before);
  });

  it('measures credit polling over the span actually read when the row cap truncates usage', async () => {
    // 0.5 polls per completion, spread evenly: 100 completions 10 minutes apart, 50 polls 20 apart.
    const poller = await seedUser();
    await seedUsage(
      poller,
      Array.from({ length: 100 }, (_, i) => new Date(now.getTime() - (i + 1) * 10 * MINUTE)),
      { apiKeyId: 'k', source: 'api' }
    );
    await ApiKeyUsageLog.collection.insertMany(
      Array.from({ length: 50 }, (_, i) => ({
        keyId: 'k',
        userId: poller,
        timestamp: new Date(now.getTime() - (i + 1) * 20 * MINUTE + MINUTE),
        endpoint: CREDIT_BALANCE_ENDPOINT,
        method: 'GET',
        ipAddress: '192.0.2.1',
        responseTime: 10,
        statusCode: 200,
      }))
    );
    const polling = async (maxEventsPerUser: number) => {
      h.getSettingsMap.mockResolvedValue({
        usagePatternSignalsEnabled: 'true',
        usagePatternSignalsConfig: JSON.stringify({ ...sampleConfig, creditPollMinCount: 1, maxEventsPerUser }),
      });
      await runUsagePatternSignals({ now });
      return (await userUsagePatternSignalsRepository.findByUserId(poller))?.signals.find(
        s => s.id === 'creditPolling'
      );
    };

    expect(await polling(5000)).toMatchObject({ value: 0.5, triggered: false });
    expect(await polling(20)).toMatchObject({ value: 0.5, triggered: false });
  });

  it('counts signed-in CLI usage as session usage, not API usage', async () => {
    const cliUser = await seedUser();
    const times = Array.from({ length: 30 }, (_, i) => new Date(now.getTime() - (i + 1) * 7 * MINUTE));
    await seedUsage(cliUser, times, { source: 'cli' });

    await runUsagePatternSignals({ now });

    const stored = await userUsagePatternSignalsRepository.findByUserId(cliUser);
    expect(stored?.signals.find(s => s.id === 'apiOnlyUsage')).toMatchObject({ value: 0, triggered: false });
  });

  it('leaves org-billed usage out of the personal profile', async () => {
    const member = await seedUser();
    await seedUsage(member, [new Date(now.getTime() - MINUTE)], { source: 'web' });
    const orgTimes = Array.from({ length: 30 }, (_, i) => new Date(now.getTime() - (i + 2) * 7 * MINUTE));
    await UsageEvent.collection.insertMany(
      orgTimes.map((createdAt, i) => ({
        userId: member,
        requestId: `${member}-org-${i}`,
        ownerType: CreditHolderType.Organization,
        createdAt,
        apiKeyId: 'org-key',
        source: 'api',
      }))
    );

    await runUsagePatternSignals({ now });

    const stored = await userUsagePatternSignalsRepository.findByUserId(member);
    expect(stored?.signals.find(s => s.id === 'apiOnlyUsage')).toMatchObject({ value: 0, triggered: false });
  });

  it('does not count traffic on a sign-in exchange key as API usage', async () => {
    const appUser = await seedUser();
    const key = await UserApiKey.collection.insertOne({
      userId: appUser,
      keyPrefix: appUser,
      name: 'exchange',
      metadata: { createdFrom: 'oauth-exchange' },
      createdAt: new Date(now.getTime() - 24 * 60 * MINUTE),
    });
    const times = Array.from({ length: 30 }, (_, i) => new Date(now.getTime() - (i + 1) * 7 * MINUTE));
    await seedUsage(appUser, times, { apiKeyId: String(key.insertedId), source: 'cli' });

    await runUsagePatternSignals({ now });

    const stored = await userUsagePatternSignalsRepository.findByUserId(appUser);
    expect(stored?.signals.find(s => s.id === 'apiOnlyUsage')).toMatchObject({ value: 0, triggered: false });
  });

  it('rotates through candidates when there are more than the per-run cap, without spending the cap on paid users', async () => {
    const paid = await seedUser();
    await seedUsage(paid, [new Date(now.getTime() - MINUTE)], {});
    const free = [await seedUser(), await seedUser(), await seedUser()];
    for (const userId of free) await seedUsage(userId, [new Date(now.getTime() - MINUTE)], {});
    h.getActiveSubscriptionsForUser.mockImplementation(async (userId: string) => (userId === paid ? [{}] : []));
    h.getSettingsMap.mockResolvedValue({
      usagePatternSignalsEnabled: 'true',
      usagePatternSignalsConfig: JSON.stringify({ ...sampleConfig, maxUsersPerRun: 2 }),
    });

    expect(await runUsagePatternSignals({ now })).toMatchObject({ analyzed: 2, skippedPaid: 1 });
    const firstRun = (await UserUsagePatternSignals.find({ skipped: null }).lean()).map(r => r.userId);
    await runUsagePatternSignals({ now: new Date(now.getTime() + MINUTE) });

    const missed = free.find(id => !firstRun.includes(id));
    expect(missed).toBeDefined();
    expect(await userUsagePatternSignalsRepository.findByUserId(missed!)).toMatchObject({
      computedAt: new Date(now.getTime() + MINUTE),
    });
    expect((await UserUsagePatternSignals.find({ skipped: null }).lean()).map(r => r.userId).sort()).toEqual(
      [...free].sort()
    );
  });

  it('stops early when out of time and picks up the missed users on the next run', async () => {
    const users = [await seedUser(), await seedUser()];
    for (const userId of users) await seedUsage(userId, [new Date(now.getTime() - MINUTE)], {});
    let checks = 0;

    const stopped = await runUsagePatternSignals({ now, shouldStop: () => checks++ >= 1 });

    expect(stopped).toMatchObject({ status: 'stopped', analyzed: 1 });
    await runUsagePatternSignals({ now: new Date(now.getTime() + MINUTE), shouldStop: () => false });
    const missed = await UserUsagePatternSignals.findOne({ computedAt: new Date(now.getTime() + MINUTE) }).lean();
    expect(users).toContain(missed?.userId);
    expect(await UserUsagePatternSignals.countDocuments()).toBe(2);
  });

  it('scores free users within the first runs even when paid users outnumber the time budget', async () => {
    const paid: string[] = [];
    for (let i = 0; i < 5; i++) paid.push(await seedUser());
    const free = [await seedUser(), await seedUser()];
    for (const userId of [...paid, ...free]) await seedUsage(userId, [new Date(now.getTime() - MINUTE)], {});
    h.getActiveSubscriptionsForUser.mockImplementation(async (userId: string) => (paid.includes(userId) ? [{}] : []));
    // Each run has time for four users.
    const budget = () => {
      let checks = 0;
      return () => checks++ >= 4;
    };

    await runUsagePatternSignals({ now, shouldStop: budget() });
    await runUsagePatternSignals({ now: new Date(now.getTime() + MINUTE), shouldStop: budget() });

    const scored = await UserUsagePatternSignals.find({ skipped: null }).lean();
    expect(scored.map(r => r.userId).sort()).toEqual([...free].sort());
    expect(await UserUsagePatternSignals.countDocuments({ skipped: 'paid', needsReview: false })).toBe(paid.length);
  });

  describe('scriptedGrantDrain', () => {
    const at = (minutesAfterSignup: number, signupAt: Date) =>
      new Date(signupAt.getTime() + minutesAfterSignup * MINUTE);

    /**
     * The farm sequence: signup grant, 2FA on, notebook activity unlock, one premium turn that spends
     * nearly all of it, a post-turn system job, logout. Minutes are offsets from signup.
     */
    async function seedFreshAccount(options: {
      mfa: boolean;
      activityUnlock: boolean;
      turns: { minute: number; credits: number; source?: string }[];
      logoutMinute: number | null;
      signupMinutesAgo?: number;
    }) {
      const signupAt = new Date(now.getTime() - (options.signupMinutesAgo ?? 50) * MINUTE);
      const userId = await seedUser({
        createdAt: signupAt,
        emailVerifiedAt: signupAt,
        ...(options.mfa ? { mfa: { totpEnabled: true, setupAt: at(2, signupAt) } } : {}),
        loginRecords: [
          {
            loginTime: signupAt,
            ...(options.logoutMinute === null ? {} : { logoutTime: at(options.logoutMinute, signupAt) }),
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Test/1.0',
            browser: 'Chrome',
            operatingSystem: 'Linux',
            deviceType: 'Desktop',
            screenResolution: '376x835',
            viewportSize: '376x700',
            colorDepth: 24,
            pixelDepth: 24,
            devicePixelRatio: 3.25,
          },
        ],
      });
      const ledger: Record<string, unknown>[] = [
        { type: 'generic_add', credits: 1000, reason: 'signup_tranche', createdAt: at(0, signupAt) },
        ...(options.activityUnlock
          ? [{ type: 'generic_add', credits: 1000, reason: 'signup_unlock:activity', createdAt: at(4, signupAt) }]
          : []),
        ...options.turns.map(turn => ({
          type: 'text_generation_usage',
          credits: turn.credits,
          source: turn.source ?? 'web',
          createdAt: at(turn.minute, signupAt),
        })),
      ];
      await CreditTransaction.collection.insertMany(
        ledger.map(row => ({ ownerId: userId, ownerType: CreditHolderType.User, ...row }))
      );
      // The candidate scan finds accounts through recent usage.
      await seedUsage(
        userId,
        options.turns.map(turn => at(turn.minute, signupAt)),
        { source: 'web' }
      );
      return userId;
    }

    it('flags the farm sequence and records one shadow detection for it, across runs', async () => {
      const farm = await seedFreshAccount({
        mfa: true,
        activityUnlock: true,
        turns: [
          { minute: 8, credits: 1990 },
          { minute: 8.2, credits: 25, source: 'system' },
        ],
        logoutMinute: 12,
      });

      const first = await runUsagePatternSignals({ now });
      expect(first).toMatchObject({ analyzed: 1, needsReview: 1, scriptedDrainDetections: 1 });
      const stored = await userUsagePatternSignalsRepository.findByUserId(farm);
      const drain = stored?.signals.find(signal => signal.id === 'scriptedGrantDrain');
      expect(drain).toMatchObject({ triggered: true, value: 12 });

      const detections = await ShadowDetectionModel.find({ detector: 'scriptedGrantDrain' }).lean();
      expect(detections).toHaveLength(1);
      expect(detections[0]).toMatchObject({ userIds: [farm], wouldAction: 'contain', verdict: null });
      expect(detections[0].signals.find(signal => signal.key === 'largestTurnGrantShare')?.observed).toBe(1);

      expect(await runUsagePatternSignals({ now })).toMatchObject({ scriptedDrainDetections: 0 });
      expect(await ShadowDetectionModel.countDocuments({ detector: 'scriptedGrantDrain' })).toBe(1);
      // Observation only: the account itself is untouched.
      const user = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(farm) });
      expect(user?.isBanned).toBe(false);
    });

    it('does not flag a genuine new user who ran one big premium turn', async () => {
      // OAuth-style signup: no 2FA, no activity unlock, varied use, no logout.
      await seedFreshAccount({
        mfa: false,
        activityUnlock: false,
        turns: [
          { minute: 3, credits: 900 },
          { minute: 15, credits: 20 },
          { minute: 22, credits: 35 },
          { minute: 40, credits: 15 },
        ],
        logoutMinute: null,
      });
      // Same big turn and logout, but without the 2FA step and with ordinary use.
      await seedFreshAccount({
        mfa: false,
        activityUnlock: true,
        turns: [{ minute: 6, credits: 1800 }],
        logoutMinute: 10,
      });

      const result = await runUsagePatternSignals({ now });
      expect(result).toMatchObject({ analyzed: 2, scriptedDrainDetections: 0 });
      expect(await ShadowDetectionModel.countDocuments()).toBe(0);
    });

    it('does not flag the sequence when it ran slower than the window', async () => {
      await seedFreshAccount({
        mfa: true,
        activityUnlock: true,
        turns: [{ minute: 70, credits: 1990 }],
        logoutMinute: 75,
        signupMinutesAgo: 100,
      });

      expect(await runUsagePatternSignals({ now })).toMatchObject({ analyzed: 1, scriptedDrainDetections: 0 });
    });

    it('records nothing while shadow detection recording is off', async () => {
      h.getSettingsMap.mockResolvedValue({
        usagePatternSignalsEnabled: 'true',
        usagePatternSignalsConfig: JSON.stringify(sampleConfig),
        shadowDetectionRecordingEnabled: 'false',
      });
      await seedFreshAccount({
        mfa: true,
        activityUnlock: true,
        turns: [{ minute: 8, credits: 1990 }],
        logoutMinute: 12,
      });

      expect(await runUsagePatternSignals({ now })).toMatchObject({ needsReview: 1, scriptedDrainDetections: 0 });
      expect(await ShadowDetectionModel.countDocuments()).toBe(0);
    });
  });
});
