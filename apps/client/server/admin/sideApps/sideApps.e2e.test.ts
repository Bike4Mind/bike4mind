import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentExecutionModel,
  ApiKeyUsageLog,
  CreditTransaction,
  OAuthClientModel,
  Quest,
  SideAppRefusal,
  SideAppRefusalCounter,
  User,
  UserApiKey,
  mongoose,
} from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { readSideApps } from './readSideApps';
import { readSideAppUsers } from './readSideAppUsers';

const { getActiveSubscriptionsForUser } = vi.hoisted(() => ({ getActiveSubscriptionsForUser: vi.fn() }));
vi.mock('@bike4mind/server-utils/entitlements/activeSubscriptions', () => ({ getActiveSubscriptionsForUser }));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-17T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const oid = () => new mongoose.Types.ObjectId();

const [u1, u2, u3, u4] = [oid(), oid(), oid(), oid()];
const [exchangeKey, personalKey, orgExchangeKey, oldExchangeKey] = [oid(), oid(), oid(), oid()];

const charge = (extra: Record<string, unknown>) => ({
  ownerId: String(u1),
  ownerType: 'User',
  type: 'completion_api_usage',
  credits: -1,
  createdAt: ago(1),
  updatedAt: ago(1),
  ...extra,
});
const request = (extra: Record<string, unknown>) => ({
  keyId: 'key',
  userId: String(u1),
  ipAddress: '127.0.0.1',
  method: 'POST',
  responseTime: 5,
  statusCode: 200,
  endpoint: '/api/ai/v1/completions',
  timestamp: ago(1),
  oauthClientId: 'app-a',
  ...extra,
});
const completion = (outcome: string) => ({
  completionObservation: { requestId: 'r', requestedModel: 'm', startedAt: 's', outcome },
});

let mongo: Awaited<ReturnType<typeof createMongoServer>>;

async function seed() {
  await OAuthClientModel.collection.insertMany([
    { clientId: 'app-a', name: 'App A' },
    { clientId: 'app-b', name: 'App B' },
  ]);
  await UserApiKey.collection.insertMany([
    { _id: exchangeKey, userId: String(u4), metadata: { createdFrom: 'oauth-exchange', oauthClientId: 'app-a' } },
    { _id: orgExchangeKey, userId: String(u4), metadata: { createdFrom: 'oauth-exchange', oauthClientId: 'app-a' } },
    { _id: oldExchangeKey, userId: String(u4), metadata: { createdFrom: 'oauth-exchange', oauthClientId: 'app-a' } },
    { _id: personalKey, userId: String(u4), metadata: { createdFrom: 'api' } },
  ]);
  await CreditTransaction.collection.insertMany([
    charge({ oauthClientId: 'app-a', payerStanding: 'paid', credits: -10, model: 'm-a' }),
    charge({ oauthClientId: 'app-a', payerStanding: 'unpaid', credits: -20, ownerId: String(u2), model: 'm-a' }),
    charge({ oauthClientId: 'app-a', credits: -5, ownerId: String(u3) }),
    charge({
      oauthClientId: 'app-a',
      ownerType: 'Organization',
      ownerId: 'org-1',
      credits: -7,
      model: 'm-b',
      metadata: { actingUserId: String(u1) },
    }),
    charge({ oauthClientId: 'app-a', type: 'generic_add', credits: 100 }),
    charge({ oauthClientId: 'app-a', payerStanding: 'paid', credits: -6, createdAt: ago(200) }),
    charge({ oauthClientId: 'app-b', payerStanding: 'paid', credits: -3 }),
    charge({ apiKeyId: String(exchangeKey), credits: -4, ownerId: String(u4) }),
    charge({ apiKeyId: String(orgExchangeKey), ownerType: 'Organization', ownerId: 'org-1', credits: -2 }),
    charge({ apiKeyId: String(oldExchangeKey), credits: -50, ownerId: String(u4), createdAt: ago(100) }),
    charge({ apiKeyId: String(personalKey), credits: -9, ownerId: String(u4) }),
  ]);
  await ApiKeyUsageLog.collection.insertMany([
    request({ payerStanding: 'paid', ...completion('completed') }),
    request({ payerStanding: 'unpaid', userId: String(u2), ...completion('failed') }),
    request({ payerStanding: 'unpaid', userId: String(u2), ...completion('interrupted') }),
    request({ payerStanding: 'paid', endpoint: '/api/chat' }),
    request({ payerStanding: 'paid', endpoint: '/api/tools/weather' }),
    request({ endpoint: '/api/tools/web-search', statusCode: 502, userId: String(u2) }),
    request({ timestamp: ago(100), ...completion('failed') }),
    request({ oauthClientId: 'app-b', endpoint: '/api/tools/weather' }),
  ]);
  await Quest.collection.insertMany([
    { oauthClientId: 'app-a', timestamp: ago(1), status: 'done', type: 'message' },
    { oauthClientId: 'app-a', timestamp: ago(1), status: 'done', type: 'error' },
    { oauthClientId: 'app-a', timestamp: ago(1), status: 'running', type: 'message' },
  ]);
  await AgentExecutionModel.collection.insertMany([
    { oauthClientId: 'app-a', createdAt: ago(1), status: 'completed' },
    { oauthClientId: 'app-a', createdAt: ago(1), status: 'failed' },
    { oauthClientId: 'app-a', createdAt: ago(1), status: 'running' },
  ]);
  await SideAppRefusal.collection.insertMany([
    {
      clientId: 'app-a',
      stage: 'mint',
      reason: 'subscription_required',
      status: 403,
      userId: String(u1),
      createdAt: ago(1),
    },
    { clientId: 'app-a', stage: 'mint', reason: 'subscription_required', status: 403, createdAt: ago(1) },
    { clientId: 'app-a', stage: 'use', reason: 'server_error', status: 500, createdAt: ago(1) },
    { clientId: 'app-a', stage: 'mint', reason: 'invalid_grant', status: 400, createdAt: ago(1) },
    { clientId: 'app-a', stage: 'mint', reason: 'invalid_grant', status: 400, createdAt: ago(100) },
  ]);
  await SideAppRefusalCounter.collection.insertMany([
    { hour: ago(1), reason: 'invalid_client', count: 5 },
    { hour: ago(2), reason: 'rate_limited', count: 2 },
  ]);
  await User.collection.insertMany([
    { _id: u1, name: 'User One', email: 'one@example.test', username: 'one', lastCreditsPurchasedAt: ago(5) },
    { _id: u2, name: 'User Two', email: 'two@example.test', username: 'two' },
    { _id: u3, name: 'User Three', email: 'three@example.test', username: 'three' },
  ]);
}

describe('side apps board reads', () => {
  beforeAll(async () => {
    mongo = await createMongoServer();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    await Promise.all(
      [
        OAuthClientModel,
        UserApiKey,
        CreditTransaction,
        ApiKeyUsageLog,
        Quest,
        AgentExecutionModel,
        SideAppRefusal,
        SideAppRefusalCounter,
        User,
      ].map(model => model.collection.deleteMany({}))
    );
    getActiveSubscriptionsForUser.mockReset();
    getActiveSubscriptionsForUser.mockResolvedValue([]);
    await seed();
  });

  describe('rows stamped and carrying an exchange key', () => {
    it('counts a charge with both oauthClientId and apiKeyId once on the list and users reads', async () => {
      const listBefore = (await readSideApps(30, now)).apps.find(app => app.clientId === 'app-a');
      const usersBefore = await readSideAppUsers('app-a', 30, now);
      const userOneBefore = usersBefore.users.find(row => row.userId === String(u1))?.credits ?? 0;

      await CreditTransaction.collection.insertOne(
        charge({ oauthClientId: 'app-a', apiKeyId: String(exchangeKey), payerStanding: 'paid', credits: -13 })
      );

      const listAfter = (await readSideApps(30, now)).apps.find(app => app.clientId === 'app-a');
      const usersAfter = await readSideAppUsers('app-a', 30, now);
      expect(listAfter?.spend.credits).toBe((listBefore?.spend.credits ?? 0) + 13);
      expect(usersAfter.users.find(row => row.userId === String(u1))?.credits).toBe(userOneBefore + 13);
    });
  });

  describe('readSideApps', () => {
    it('splits spend into paid, unpaid, org and unrecorded and counts charges only', async () => {
      const result = await readSideApps(30, now);
      const appA = result.apps.find(app => app.clientId === 'app-a');

      expect(appA?.name).toBe('App A');
      expect(appA?.spend.byTier).toEqual({ paid: 10, unpaid: 20, org: 9, unrecorded: 9 });
      expect(appA?.spend.credits).toBe(48);
      expect(appA?.spend.payingUsers).toBe(4);
      expect(appA?.spend.daily.reduce((sum, day) => sum + day.credits, 0)).toBe(48);
      expect(result.totals.byTier.unpaid).toBe(20);
      expect(result.totals.unpaidShare).toBeCloseTo(20 / 33);
    });

    it('attributes unstamped rows inside 90 days through their exchange key and nothing older', async () => {
      const result = await readSideApps(365, now);
      const appA = result.apps.find(app => app.clientId === 'app-a');

      // The 100-day-old unstamped row (50) and the personal-key row (9) never count; the 200-day-old stamped row does.
      expect(appA?.spend.credits).toBe(54);
      expect(appA?.spend.byTier.paid).toBe(16);
      expect(appA?.spend.byTier.unrecorded).toBe(9);
    });

    it('does not attribute unstamped rows that fall before the 90-day cut inside a short window', async () => {
      const result = await readSideApps(30, now);
      expect(result.totals.credits).toBe(48 + 3);
    });

    it('reports requests, outcomes and the shared failure rate', async () => {
      const appA = (await readSideApps(30, now)).apps.find(app => app.clientId === 'app-a');

      expect(appA?.requests.total).toBe(6);
      expect(appA?.requests.byTier).toEqual({ paid: 3, unpaid: 2, unrecorded: 1 });
      expect(appA?.requests.byEndpoint.find(row => row.endpoint === '/api/chat')?.total).toBe(1);
      expect(appA?.outcomes).toMatchObject({ completed: 4, failed: 4, interrupted: 1 });
      expect(appA?.outcomes.failureRate).toBeCloseTo(5 / 9);
    });

    it('keeps accepted audio jobs out of completed outcomes and failure-rate denominators', async () => {
      const clientId = 'audio-app';
      await OAuthClientModel.collection.insertOne({ clientId, name: 'Audio App' });
      await ApiKeyUsageLog.collection.insertMany([
        request({ oauthClientId: clientId, endpoint: '/api/ai/tts', statusCode: 200 }),
        request({ oauthClientId: clientId, endpoint: '/api/ai/tts', statusCode: 202 }),
        request({ oauthClientId: clientId, endpoint: '/api/ai/sound-effects', statusCode: 200 }),
        request({ oauthClientId: clientId, endpoint: '/api/ai/sound-effects', statusCode: 202 }),
        request({ oauthClientId: clientId, endpoint: '/api/ai/sound-effects', statusCode: 502 }),
      ]);

      const app = (await readSideApps(30, now)).apps.find(row => row.clientId === clientId);
      expect(app?.requests.total).toBe(5);
      expect(app?.outcomes).toMatchObject({ completed: 2, failed: 1, interrupted: 0 });
      expect(app?.outcomes.failureRate).toBeCloseTo(1 / 3);
      const users = await readSideAppUsers(clientId, 30, now);
      expect(users.users).toHaveLength(1);
      expect(users.users[0]).toMatchObject({ userId: String(u1), requests: 5, failedRequests: 1 });
    });

    it('retains terminal completion observations even on accepted HTTP responses', async () => {
      const clientId = 'observed-app';
      await OAuthClientModel.collection.insertOne({ clientId, name: 'Observed App' });
      await ApiKeyUsageLog.collection.insertMany(
        ['completed', 'failed', 'interrupted'].map(outcome =>
          request({ oauthClientId: clientId, statusCode: 202, ...completion(outcome) })
        )
      );

      const app = (await readSideApps(30, now)).apps.find(row => row.clientId === clientId);
      expect(app?.requests.total).toBe(3);
      expect(app?.outcomes).toMatchObject({ completed: 1, failed: 1, interrupted: 1 });
      expect(app?.outcomes.failureRate).toBeCloseTo(2 / 3);
      const users = await readSideAppUsers(clientId, 30, now);
      expect(users.users[0]).toMatchObject({ userId: String(u1), requests: 3, failedRequests: 2 });
    });

    it('lists the top five failure codes of failed completions, most frequent first, ties by code', async () => {
      const clientId = 'coded-app';
      await OAuthClientModel.collection.insertOne({ clientId, name: 'Coded App' });
      const observed = (outcome: string, failureCode?: string) => ({
        completionObservation: { requestId: 'r', requestedModel: 'm', startedAt: 's', outcome, failureCode },
      });
      const failed = (failureCode?: string) => observed('failed', failureCode);
      const rows = (failureCode: string | undefined, times: number) =>
        Array.from({ length: times }, () => request({ oauthClientId: clientId, ...failed(failureCode) }));
      await ApiKeyUsageLog.collection.insertMany([
        ...rows('http_503', 4),
        ...rows('rate_limited', 3),
        ...rows('zulu', 2),
        ...rows('yankee', 2),
        ...rows('mike', 2),
        ...rows('charlie', 2),
        ...rows('alpha', 2),
        ...rows('bravo', 2),
        ...rows('rare', 1),
        ...rows(undefined, 1),
        request({ oauthClientId: clientId, ...observed('completed', 'completed_code') }),
        request({ oauthClientId: clientId, ...observed('completed', 'completed_code') }),
        request({ oauthClientId: clientId, ...observed('completed', 'completed_code') }),
        request({ oauthClientId: clientId, ...observed('completed', 'completed_code') }),
        request({ oauthClientId: clientId, ...observed('completed', 'completed_code') }),
      ]);

      const app = (await readSideApps(30, now)).apps.find(row => row.clientId === clientId);
      expect(app?.topFailureCodes).toEqual([
        { code: 'http_503', count: 4 },
        { code: 'rate_limited', count: 3 },
        { code: 'alpha', count: 2 },
        { code: 'bravo', count: 2 },
        { code: 'charlie', count: 2 },
      ]);
    });

    it('clamps the windows and caps requests at the log retention', async () => {
      const wide = await readSideApps(1000, now);
      expect(wide.spendWindowDays).toBe(365);
      expect(wide.requestWindowDays).toBe(90);
      // The 100-day-old request and refusal rows sit outside the 90-day request window.
      const appA = wide.apps.find(app => app.clientId === 'app-a');
      expect(appA?.requests.total).toBe(6);
      expect(appA?.refusals.byReason.find(row => row.reason === 'invalid_grant')?.count).toBe(1);

      const narrow = await readSideApps(0, now);
      expect(narrow.spendWindowDays).toBe(1);
      expect(narrow.requestWindowDays).toBe(1);
      expect((await readSideApps(30, now)).requestWindowDays).toBe(30);
    });

    it('groups refusals by class and reason and keeps the unverified counter out of app rows', async () => {
      const result = await readSideApps(30, now);
      const appA = result.apps.find(app => app.clientId === 'app-a');

      expect(appA?.refusals.byClass).toEqual({ policy: 2, app_fault: 1, our_fault: 1 });
      expect(appA?.refusals.total).toBe(4);
      expect(result.apps.map(app => app.clientId).sort()).toEqual(['app-a', 'app-b']);
      expect(result.unknownClient.total).toBe(7);
      expect(result.unknownClient.byReason.map(row => [row.reason, row.count])).toEqual([
        ['invalid_client', 5],
        ['rate_limited', 2],
      ]);
    });

    it('reports when tiers started being recorded', async () => {
      expect((await readSideApps(30, now)).attributionStartedAt).toBe(ago(200).toISOString());
      await CreditTransaction.deleteMany({ oauthClientId: { $exists: true } });
      expect((await readSideApps(30, now)).attributionStartedAt).toBeNull();
    });

    it('falls back to the client id when the app is not registered', async () => {
      await OAuthClientModel.deleteMany({});
      const appB = (await readSideApps(30, now)).apps.find(app => app.clientId === 'app-b');
      expect(appB?.name).toBe('app-b');
    });
  });

  describe('readSideAppUsers', () => {
    it('returns one row per user ordered by credits with tier mix, requests and models', async () => {
      const result = await readSideAppUsers('app-a', 30, now);

      expect(result.name).toBe('App A');
      expect(result.totalUsers).toBe(4);
      expect(result.users.map(row => [row.userId, row.credits])).toEqual([
        [String(u2), 20],
        [String(u1), 17],
        [String(u3), 5],
        [String(u4), 4],
      ]);
      const one = result.users.find(row => row.userId === String(u1));
      expect(one).toMatchObject({ name: 'User One', email: 'one@example.test', refusals: 1, requests: 3 });
      expect(one?.creditsByTier).toEqual({ paid: 10, unpaid: 0, org: 7, unrecorded: 0 });
      expect(one?.topModels).toEqual([
        { model: 'm-a', credits: 10 },
        { model: 'm-b', credits: 7 },
      ]);
      const two = result.users.find(row => row.userId === String(u2));
      expect(two).toMatchObject({ requests: 3, failedRequests: 3 });
      expect(result.unattributedOrgCredits).toBe(2);
    });

    it('computes the current tier for the page and says unknown when a read fails', async () => {
      getActiveSubscriptionsForUser.mockImplementation(async (id: string) => {
        if (id === String(u3)) throw new Error('subscription read failed');
        return [];
      });
      const tiers = new Map((await readSideAppUsers('app-a', 30, now)).users.map(row => [row.userId, row.currentTier]));

      expect(tiers.get(String(u1))).toBe('paid');
      expect(tiers.get(String(u2))).toBe('unpaid');
      expect(tiers.get(String(u3))).toBe('unknown');
      expect(tiers.get(String(u4))).toBe('unknown');
    });

    it('does not include another app or an unrelated key', async () => {
      const result = await readSideAppUsers('app-b', 30, now);
      expect(result.users.map(row => row.credits)).toEqual([3]);
    });
  });
});
