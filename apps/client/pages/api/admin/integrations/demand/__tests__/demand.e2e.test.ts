import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * The admin demand routes through the REAL baseApi chain: apiKeyAuth's scope gate, the per-user
 * limiter and the handlers' isAdmin check all run, against a real mongod, so the auth matrix is
 * proven end to end rather than inferred from `requiredScopes` being declared.
 *
 * Stubbed: key validation (the key store is not under test), the JWT verifier (the x-test-session
 * header names the signed-in user, who is then read from the real users collection), connectDB,
 * and the fire-and-forget usage/anomaly/analytics side effects of an API-key request.
 */

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  apiKeyRateLimit: vi.fn(),
}));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...args: unknown[]) => mocks.validate(...args),
    },
  };
});
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  auth: async (
    req: { user?: unknown; headers: Record<string, string | undefined> },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    if (req.user) return next();
    const sessionUserId = req.headers['x-test-session'];
    if (!sessionUserId) return res.status(401).json({ error: 'Authentication required' });
    const { User } = await import('@bike4mind/database');
    req.user = await User.findById(sessionUserId);
    next();
  },
}));
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...args: unknown[]) => mocks.apiKeyRateLimit(...args),
}));
vi.mock('@server/middlewares/apiKeyAnomalyDetection', () => ({
  apiKeyAnomalyDetection: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  logEventSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@server/analytics/analyticsMiddleware', () => ({
  analyticsMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { ApiKeyScope, INTEGRATION_CATALOG } from '@bike4mind/common';
import {
  IntegrationRequest,
  Organization,
  User,
  cacheRepository,
  integrationRequestRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import demandHandler from '@pages/api/admin/integrations/demand/index';
import requestersHandler from '@pages/api/admin/integrations/demand/[integrationId]/requesters';
import userRequestsHandler from '@pages/api/integrations/requests';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

type Ids = { admin: string; member: string; third: string; org: string; ghostUser: string; ghostOrg: string };
let ids: Ids;

const at = (iso: string) => new Date(iso);

beforeEach(async () => {
  mocks.apiKeyRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  const [admin, member, third] = await User.create([
    { username: 'demand-admin', name: 'Ada Admin', email: 'ada@example.com', isAdmin: true },
    { username: 'demand-member', name: 'Max Member', email: 'max@example.com' },
    { username: 'demand-third', name: 'Tia Third', email: 'tia@example.com' },
  ]);
  const org = await Organization.create({ name: 'Example Org', userId: String(admin._id) });
  ids = {
    admin: String(admin._id),
    member: String(member._id),
    third: String(third._id),
    org: String(org._id),
    // A deleted account and a deleted organization: ids that resolve to nothing.
    ghostUser: new mongoose.Types.ObjectId().toString(),
    ghostOrg: new mongoose.Types.ObjectId().toString(),
  };
  await IntegrationRequest.create([
    { userId: ids.member, organizationId: ids.org, integrationId: 'hubspot', createdAt: at('2026-03-01T00:00:00Z') },
    { userId: ids.admin, organizationId: ids.org, integrationId: 'hubspot', createdAt: at('2026-03-02T00:00:00Z') },
    { userId: ids.third, organizationId: null, integrationId: 'hubspot', createdAt: at('2026-03-03T00:00:00Z') },
    {
      userId: ids.ghostUser,
      organizationId: ids.ghostOrg,
      integrationId: 'hubspot',
      createdAt: at('2026-03-04T00:00:00Z'),
    },
    // Promoted out of the roadmap, and dropped from the catalog: both keep their history.
    { userId: ids.member, organizationId: ids.org, integrationId: 'github', createdAt: at('2026-01-01T00:00:00Z') },
    {
      userId: ids.member,
      organizationId: null,
      integrationId: 'retired-connector',
      createdAt: at('2026-01-02T00:00:00Z'),
    },
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.validate.mockReset();
  // Also clears the limiter's counters, so no test inherits another's window.
  await mongoose.connection.dropDatabase();
});

/** The next request authenticates with an API key owned by `userId` holding `scopes`. */
const withKey = (userId: string, scopes: ApiKeyScope[]) =>
  mocks.validate.mockResolvedValue({
    isValid: true,
    keyId: 'key-1',
    userId,
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });

type Caller = { session: string } | { apiKey: true } | 'anonymous';
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function fire(handler: unknown, url: string, as: Caller, query: Record<string, string> = {}) {
  const headers: Record<string, string> = {};
  if (as !== 'anonymous' && 'session' in as) headers['x-test-session'] = as.session;
  if (as !== 'anonymous' && 'apiKey' in as) headers['x-api-key'] = 'test-api-key';
  const { req, res } = createMocks({ method: 'GET', url, query, headers }, { eventEmitter: EventEmitter });
  // The end of the response is the completion signal: a middleware that answers without calling
  // next() (the 401 below, the limiter's 429) leaves next-connect's own promise pending.
  let failure: unknown;
  void (handler as Handler)(req, res).catch((error: unknown) => {
    failure = error;
  });
  while (!res._isEndCalled()) {
    if (failure) throw failure;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { status: res._getStatusCode(), body: res._getData() ? res._getJSONData() : undefined };
}

const getDemand = (as: Caller) => fire(demandHandler, '/api/admin/integrations/demand', as);
const getRequesters = (as: Caller, query: Record<string, string> = {}, integrationId = 'hubspot') =>
  fire(requestersHandler, `/api/admin/integrations/demand/${integrationId}/requesters`, as, {
    integrationId,
    ...query,
  });

describe('GET /api/admin/integrations/demand', () => {
  it('lists demand per integration, most requested first, including ids no longer on the roadmap', async () => {
    const { status, body } = await getDemand({ session: ids.admin });

    expect(status).toBe(200);
    expect(body.integrations).toEqual([
      {
        integrationId: 'hubspot',
        name: INTEGRATION_CATALOG.hubspot.name,
        stage: 'planned',
        total: 4,
        organizations: 2,
        firstRequestedAt: '2026-03-01T00:00:00.000Z',
        latestRequestedAt: '2026-03-04T00:00:00.000Z',
      },
      {
        integrationId: 'github',
        name: INTEGRATION_CATALOG.github.name,
        stage: INTEGRATION_CATALOG.github.stage,
        total: 1,
        organizations: 1,
        firstRequestedAt: '2026-01-01T00:00:00.000Z',
        latestRequestedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        integrationId: 'retired-connector',
        name: 'retired-connector',
        stage: null,
        total: 1,
        organizations: 0,
        firstRequestedAt: '2026-01-02T00:00:00.000Z',
        latestRequestedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    // Counts only: who asked is on the requesters route.
    expect(JSON.stringify(body)).not.toMatch(/example\.com|Ada Admin|Example Org/);
  });

  it("serves an admin's API key that holds admin:*", async () => {
    withKey(ids.admin, [ApiKeyScope.ADMIN]);
    const { status, body } = await getDemand({ apiKey: true });
    expect(status).toBe(200);
    expect(body.integrations).toHaveLength(3);
  });

  it.each([
    ['a narrower scope', [ApiKeyScope.READ_NOTEBOOKS]],
    ['no scopes at all', []],
  ])("403s an admin's key with %s before the handler reads anything", async (_label, scopes) => {
    const summary = vi.spyOn(integrationRequestRepository, 'demandSummary');
    withKey(ids.admin, scopes);

    const { status, body } = await getDemand({ apiKey: true });

    expect(status).toBe(403);
    expect(body.required_scopes).toEqual([ApiKeyScope.ADMIN]);
    expect(summary).not.toHaveBeenCalled();
  });

  it('403s a non-admin, whether signed in or holding an admin:* key', async () => {
    const summary = vi.spyOn(integrationRequestRepository, 'demandSummary');
    expect((await getDemand({ session: ids.member })).status).toBe(403);
    withKey(ids.member, [ApiKeyScope.ADMIN]);
    expect((await getDemand({ apiKey: true })).status).toBe(403);
    expect(summary).not.toHaveBeenCalled();
  });

  it('401s without a credential and with an invalid key', async () => {
    expect((await getDemand('anonymous')).status).toBe(401);
    mocks.validate.mockResolvedValue({ isValid: false, reason: 'not found' });
    expect((await getDemand({ apiKey: true })).status).toBe(401);
  });

  it("counts against the caller's own window in the route's own bucket", async () => {
    await getDemand({ session: ids.admin });
    expect(await cacheRepository.findByKey(`rate-limit:${ids.admin}:admin-integration-demand`)).toBeTruthy();
  });
});

describe('GET /api/admin/integrations/demand/{integrationId}/requesters', () => {
  it('lists requesters newest first with their name, email and organization, and nothing else', async () => {
    const { status, body } = await getRequesters({ session: ids.admin });

    expect(status).toBe(200);
    expect(body.next_cursor).toBeNull();
    expect(body.data).toEqual([
      {
        userId: ids.ghostUser,
        deleted: true,
        name: null,
        email: null,
        organizationId: ids.ghostOrg,
        organizationName: null,
        requestedAt: '2026-03-04T00:00:00.000Z',
      },
      {
        userId: ids.third,
        deleted: false,
        name: 'Tia Third',
        email: 'tia@example.com',
        organizationId: null,
        organizationName: null,
        requestedAt: '2026-03-03T00:00:00.000Z',
      },
      {
        userId: ids.admin,
        deleted: false,
        name: 'Ada Admin',
        email: 'ada@example.com',
        organizationId: ids.org,
        organizationName: 'Example Org',
        requestedAt: '2026-03-02T00:00:00.000Z',
      },
      {
        userId: ids.member,
        deleted: false,
        name: 'Max Member',
        email: 'max@example.com',
        organizationId: ids.org,
        organizationName: 'Example Org',
        requestedAt: '2026-03-01T00:00:00.000Z',
      },
    ]);
  });

  it('pages with an opaque cursor, resolving each page in one users read and one organizations read', async () => {
    const findUsers = vi.spyOn(userRepository, 'findRequesterProfilesByIds');
    const findOrgs = vi.spyOn(organizationRepository, 'find');

    const first = await getRequesters({ session: ids.admin }, { limit: '3' });
    expect(first.body.data.map((r: { userId: string }) => r.userId)).toEqual([ids.ghostUser, ids.third, ids.admin]);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    expect(findUsers).toHaveBeenCalledTimes(1);
    expect(findOrgs).toHaveBeenCalledTimes(1);

    const second = await getRequesters({ session: ids.admin }, { limit: '3', cursor: first.body.next_cursor });
    expect(second.body.data.map((r: { userId: string }) => r.userId)).toEqual([ids.member]);
    expect(second.body.next_cursor).toBeNull();
    expect(findUsers).toHaveBeenCalledTimes(2);
    expect(findOrgs).toHaveBeenCalledTimes(2);
  });

  describe('account and organization hygiene', () => {
    const seedExtra = async () => {
      const [gone, mover] = await User.create([
        { username: 'demand-gone', name: 'Gus Gone', email: 'gus@example.com' },
        { username: 'demand-mover', name: 'Mia Mover', email: 'mia@example.com' },
      ]);
      // deletedAt is not on the user schema, so it is written past mongoose, as the other soft-delete guards read it.
      await User.collection.updateOne({ _id: gone._id }, { $set: { deletedAt: new Date() } });
      const otherOrg = await Organization.create({ name: 'Other Org', userId: String(mover._id) });
      await User.updateOne({ _id: mover._id }, { $set: { organizationId: otherOrg._id } });
      await IntegrationRequest.create([
        {
          userId: String(gone._id),
          organizationId: ids.org,
          integrationId: 'gmail',
          createdAt: at('2026-04-01T00:00:00Z'),
        },
        {
          userId: String(mover._id),
          organizationId: ids.org,
          integrationId: 'gmail',
          createdAt: at('2026-04-02T00:00:00Z'),
        },
        // No organization on the user, so the one stored on the request stands.
        { userId: ids.third, organizationId: ids.org, integrationId: 'gmail', createdAt: at('2026-04-03T00:00:00Z') },
      ]);
      return { gone: String(gone._id), mover: String(mover._id), otherOrg: String(otherOrg._id) };
    };

    it('blanks a soft-deleted account instead of returning its name and email', async () => {
      const { gone } = await seedExtra();

      const { status, body } = await getRequesters({ session: ids.admin }, {}, 'gmail');

      expect(status).toBe(200);
      expect(body.data.find((r: { userId: string }) => r.userId === gone)).toMatchObject({
        deleted: true,
        name: null,
        email: null,
      });
      expect(JSON.stringify(body)).not.toMatch(/gus@example\.com|Gus Gone/);
    });

    it("shows the organization a user belongs to now, falling back to the request's own only for a user with none", async () => {
      const { mover, otherOrg } = await seedExtra();

      const { body } = await getRequesters({ session: ids.admin }, {}, 'gmail');

      const byUser = (userId: string) => body.data.find((r: { userId: string }) => r.userId === userId);
      expect(byUser(mover)).toMatchObject({ organizationId: otherOrg, organizationName: 'Other Org' });
      expect(byUser(ids.third)).toMatchObject({ organizationId: ids.org, organizationName: 'Example Org' });
    });
  });

  it('rejects a cursor longer than 512 characters before reading anything', async () => {
    const list = vi.spyOn(integrationRequestRepository, 'requestersFor');

    const { status, body } = await getRequesters({ session: ids.admin }, { cursor: 'x'.repeat(513) });

    expect(status).toBe(422);
    expect(JSON.stringify(body)).toMatch(/512/);
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a cursor minted for another integration's list", async () => {
    const first = await getRequesters({ session: ids.admin }, { limit: '1' });
    const foreign = await getRequesters({ session: ids.admin }, { cursor: first.body.next_cursor }, 'gmail');
    expect(foreign.status).toBe(422);
  });

  it.each([{ limit: '0' }, { limit: '101' }, { limit: 'many' }, { cursor: 'not-a-cursor' }])(
    'rejects %o with 422',
    async query => {
      expect((await getRequesters({ session: ids.admin }, query)).status).toBe(422);
    }
  );

  it('answers an empty page for an id nobody requested', async () => {
    expect(await getRequesters({ session: ids.admin }, {}, 'linear')).toEqual({
      status: 200,
      body: { data: [], next_cursor: null },
    });
  });

  it("serves an admin's admin:* key and 403s every other caller before reading", async () => {
    withKey(ids.admin, [ApiKeyScope.ADMIN]);
    expect((await getRequesters({ apiKey: true })).status).toBe(200);

    const list = vi.spyOn(integrationRequestRepository, 'requestersFor');
    withKey(ids.admin, [ApiKeyScope.READ_PROJECTS]);
    const underScoped = await getRequesters({ apiKey: true });
    expect(underScoped.status).toBe(403);
    expect(underScoped.body.required_scopes).toEqual([ApiKeyScope.ADMIN]);
    withKey(ids.member, [ApiKeyScope.ADMIN]);
    expect((await getRequesters({ apiKey: true })).status).toBe(403);
    expect((await getRequesters({ session: ids.member })).status).toBe(403);
    expect((await getRequesters('anonymous')).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('the user route (pages/api/integrations/requests.ts) never carries requester data', () => {
  it('gives a signed-in member counts and their own ids only', async () => {
    const { status, body } = await fire(userRequestsHandler, '/api/integrations/requests', { session: ids.member });

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['counts', 'mine']);
    expect(body.counts).toEqual({ hubspot: 4 });
    expect(JSON.stringify(body)).not.toMatch(
      new RegExp([ids.admin, ids.third, ids.ghostUser, ids.org, 'example\\.com', '2026-'].join('|'))
    );
  });

  it('is unreachable with an admin:* key, which it never validates', async () => {
    withKey(ids.admin, [ApiKeyScope.ADMIN]);
    expect((await fire(userRequestsHandler, '/api/integrations/requests', { apiKey: true })).status).toBe(401);
    expect(mocks.validate).not.toHaveBeenCalled();
  });
});
