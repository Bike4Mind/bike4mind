// @vitest-environment node
/**
 * Drives the real `baseApi` chain (as overwatch/v1 and identify do) with the data edges and the
 * reward service stubbed: who may reach the payout, and what never becomes one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockFindById, mockRateLimit, mockGrant } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGrant: vi.fn(),
}));

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': '60',
  'X-RateLimit-Remaining-Minute': '59',
  'X-RateLimit-Reset-Minute': '0',
  'X-RateLimit-Limit-Day': '1000',
  'X-RateLimit-Remaining-Day': '999',
  'X-RateLimit-Reset-Day': '0',
};

vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/server-utils/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@server/partners/bedrocknewsPuzzleReward', () => ({
  grantPuzzleReward: (...a: unknown[]) => mockGrant(...a),
}));

// The MFA-enrolment gate behind a session reads an admin setting from Mongo, which this test has none
// of; the JWT check and the consent gate still run for real.
vi.mock('@bike4mind/server-utils/auth/mfaEnforcement', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  isMfaEnrollmentOwed: async () => false,
}));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
  };
});

import handler, { config } from '../rewards/grant';
import { ApiKeyScope } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

const VALID_KEY = 'b4m_live_0123456789abcdef0123456789abcdef';
const KEY_OWNER = {
  id: 'service-user',
  _id: 'service-user',
  isBanned: false,
  disputePending: false,
  aupAcceptedVersion: 'grandfathered',
};
const PLAYER_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const TODAY = '2026-11-02';
const BODY = { userId: PLAYER_ID, puzzleDate: TODAY, tier: 5, hard: false };
const GRANTED = { ok: true, granted: true, credits: 40, balance: 1540, firstSolveCredits: 500 };

const dayOffset = (days: number) => new Date(Date.UTC(2026, 10, 2 + days)).toISOString().slice(0, 10);

function fire({
  body = BODY,
  apiKey = VALID_KEY,
  sessionUser,
}: { body?: unknown; apiKey?: string | null; sessionUser?: Record<string, unknown> } = {}) {
  const payload = JSON.stringify(body);
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/partners/rewards/grant',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: body as Record<string, unknown>,
    },
    { eventEmitter: EventEmitter }
  );
  // A session caller arrives with req.user already set, which is how the JWT strategy leaves it.
  if (sessionUser) (req as { user?: unknown }).user = sessionUser;
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

const holdScopes = (scopes: ApiKeyScope[]) =>
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'service-user',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });

describe('POST /api/partners/rewards/grant', () => {
  let logInfo: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
    logInfo = vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
    holdScopes([ApiKeyScope.REWARDS_GRANT]);
    mockFindById.mockReturnValue(Promise.resolve(KEY_OWNER));
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
    mockGrant.mockResolvedValue(GRANTED);
  });

  afterEach(() => {
    vi.useRealTimers();
    logInfo.mockRestore();
  });

  it('keeps Next.js body parsing on and resolves the response itself', () => {
    const api = (config as { api?: { bodyParser?: unknown; externalResolver?: unknown } }).api;
    expect(api?.bodyParser).not.toBe(false);
    expect(api?.externalResolver).toBe(true);
  });

  describe('a key holding rewards:grant', () => {
    it('pays through the service with the parsed body and answers its four fields', async () => {
      const { req, res } = fire();
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ granted: true, credits: 40, balance: 1540, firstSolveCredits: 500 });
      expect(mockGrant).toHaveBeenCalledTimes(1);
      expect(mockGrant).toHaveBeenCalledWith(BODY);
    });

    it('hands the service only the four contract fields', async () => {
      const { req, res } = fire({ body: { ...BODY, credits: 1_000_000, ownerId: 'someone-else' } });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(mockGrant).toHaveBeenCalledWith(BODY);
    });

    it('answers a replay as granted false with the stored amount', async () => {
      mockGrant.mockResolvedValue({ ok: true, granted: false, credits: 40, balance: 1540, firstSolveCredits: 0 });
      const { req, res } = fire();
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ granted: false, credits: 40, balance: 1540, firstSolveCredits: 0 });
    });

    it('logs one line per grant with the outcome and no key material', async () => {
      const { req, res } = fire();
      await handler(req, res);

      const grantLogs = logInfo.mock.calls.filter(([message]) => message === '[partners] headword reward');
      expect(grantLogs).toEqual([
        ['[partners] headword reward', { userId: PLAYER_ID, puzzleDate: TODAY, tier: 5, granted: true, credits: 40 }],
      ]);
      expect(JSON.stringify(logInfo.mock.calls)).not.toContain(VALID_KEY);
    });

    it.each([
      [404, 'USER_NOT_FOUND'],
      [403, 'USER_NOT_ELIGIBLE'],
      [403, 'DAILY_CAP'],
      [403, 'BUDGET_EXHAUSTED'],
    ])('relays a refusal of %i %s with its code', async (status, code) => {
      mockGrant.mockResolvedValue({ ok: false, status, code });
      const { req, res } = fire();
      await handler(req, res);

      expect(res._getStatusCode()).toBe(status);
      expect(res._getJSONData()).toMatchObject({ error: expect.any(String), code });
      expect(logInfo.mock.calls.filter(([message]) => message === '[partners] headword reward')).toEqual([]);
    });

    it.each([
      ['today', 0],
      ['30 days ago', -30],
    ])('accepts a puzzleDate of %s', async (_label, offset) => {
      const { req, res } = fire({ body: { ...BODY, puzzleDate: dayOffset(offset) } });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
    });

    it.each([
      ['31 days ago', dayOffset(-31)],
      ['tomorrow', dayOffset(1)],
    ])('refuses a puzzleDate of %s with 400 before the service', async (_label, puzzleDate) => {
      const { req, res } = fire({ body: { ...BODY, puzzleDate } });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData()).toMatchObject({
        error: 'puzzleDate out of range',
        code: 'INVALID',
        request_id: expect.any(String),
      });
      expect(mockGrant).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown tier', { ...BODY, tier: 8 }],
      ['a string tier', { ...BODY, tier: '5' }],
      ['a missing hard flag', { userId: BODY.userId, puzzleDate: BODY.puzzleDate, tier: 5 }],
      ['a non-boolean hard flag', { ...BODY, hard: 'yes' }],
      ['a short userId', { ...BODY, userId: 'abc123' }],
      ['an uppercase userId', { ...BODY, userId: PLAYER_ID.toUpperCase() }],
      ['a malformed puzzleDate', { ...BODY, puzzleDate: '11/02/2026' }],
      ['an impossible puzzleDate', { ...BODY, puzzleDate: '2026-02-31' }],
      ['an empty body', {}],
    ])('refuses %s with 400 before the service', async (_label, body) => {
      const { req, res } = fire({ body });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData()).toMatchObject({ error: expect.any(String), code: 'INVALID' });
      expect(mockGrant).not.toHaveBeenCalled();
    });
  });

  describe('callers without the scope', () => {
    it.each([
      ['a confined key for another flow', [ApiKeyScope.OVERWATCH_INGEST_WRITE]],
      ['an ordinary key', [ApiKeyScope.AI_CHAT]],
      ['an admin key', [ApiKeyScope.ADMIN]],
    ])('get 403 from %s before the service runs', async (_label, scopes) => {
      holdScopes(scopes);
      const { req, res } = fire();
      await handler(req, res);

      expect(res._getStatusCode()).toBe(403);
      expect(mockGrant).not.toHaveBeenCalled();
    });

    it('gets 403 for a signed-in session with no API key: the scope gate does not apply to sessions', async () => {
      const { req, res } = fire({
        apiKey: null,
        sessionUser: { ...KEY_OWNER, id: 'player', _id: 'player', isAdmin: true },
      });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(403);
      expect(mockValidate).not.toHaveBeenCalled();
      expect(mockGrant).not.toHaveBeenCalled();
    });

    it('gets 401 with no credential at all', async () => {
      const { req, res } = fire({ apiKey: null });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(401);
      expect(mockGrant).not.toHaveBeenCalled();
    });

    it('gets 401 for a key that does not validate', async () => {
      mockValidate.mockResolvedValue({ isValid: false, reason: 'not found' });
      const { req, res } = fire();
      await handler(req, res);

      expect(res._getStatusCode()).toBe(401);
      expect(mockGrant).not.toHaveBeenCalled();
    });
  });
});
