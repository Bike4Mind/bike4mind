// @vitest-environment node
/**
 * /api/v1/tools/* posture: drives the real nextRouteForContract chain (same harness as
 * pages/api/tools/__tests__/tools.test.ts) to pin, per route, that a key holding `ai:chat` or
 * `ai:generate` runs the tool and a key holding neither is refused before it runs, and that the
 * public twins share the SPA routes' hourly budget.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { mockResolveTrust, mockValidate, mockUserFindById, mockKeyRateLimit, mockSearch, mockWebFetch, counters } =
  vi.hoisted(() => ({
    mockResolveTrust: vi.fn(),
    mockValidate: vi.fn(),
    mockUserFindById: vi.fn(),
    mockKeyRateLimit: vi.fn(),
    mockSearch: vi.fn(),
    mockWebFetch: vi.fn(),
    counters: new Map<string, number>(),
  }));

const USER = { id: 'user-1', _id: 'user-1', username: 'jules', tokenVersion: 0, isBanned: false };

vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveApiKeyTrust: (...a: unknown[]) => mockResolveTrust(...a),
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockKeyRateLimit(...a),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
    apiKeyService: { ...(actual.apiKeyService as object), getOpenWeatherKey: async () => 'weather-key' },
  };
});
vi.mock('@bike4mind/services/llm/tools/implementation/websearch', () => ({
  performWebSearch: (...a: unknown[]) => mockSearch(...a),
  resolveWebSearchProviders: async () => [null, null],
}));
vi.mock('@bike4mind/server-utils/billing/billedWebTools', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  billedWebFetch: (...a: unknown[]) => mockWebFetch(...a),
}));
// Billing has its own suite (pages/api/tools/__tests__/billing.test.ts); every call is free here.
vi.mock('@bike4mind/server-utils/billing/reserveRequestCredits', () => ({
  reserveRequestCredits: async () => ({
    ownerId: 'user-1',
    ownerType: 'user',
    reservedCredits: 0,
    hold: null,
    refund: async () => {},
    settle: async () => 0,
  }),
}));
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockUserFindById(...a) }),
    // In-memory stand-in for the Mongo-backed fixed window rateLimit counts against.
    cacheRepository: {
      tryIncrementWithinLimitFixedWindow: async (key: string, limit: number, windowMs: number) => {
        const count = (counters.get(key) ?? 0) + 1;
        if (count > limit) return { success: false, count: limit, expiresAt: new Date(Date.now() + windowMs) };
        counters.set(key, count);
        return { success: true, count, expiresAt: new Date(Date.now() + windowMs) };
      },
    },
    toolExecutionLogRepository: { create: vi.fn().mockResolvedValue({}) },
    adminSettingsRepository: { findBySettingNames: async () => [], findBySettingName: async () => null },
  };
});
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    auth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      if (!req.user) req.user = USER;
      next();
    },
  };
});

import v1WebSearch from '../web-search';
import v1WebFetch from '../web-fetch';
import v1Weather from '../weather';
import legacyWebSearch from '../../../tools/web-search';
import { TOOL_ROUTES_HOURLY_LIMIT } from '@server/middlewares/toolRoutesRateLimit';

const VALID_KEY = 'b4m_live_0123456789abcdef0123456789abcdef';

// next-connect handlers take Express req/res, which node-mocks-http mocks are not structurally; `never`
// parameters accept any handler, and the call site casts the mocks to match.
type Handler = (req: never, res: never) => unknown;

async function call(handler: Handler, url: string, body: object, apiKey?: string) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url,
      headers: { 'x-forwarded-for': '203.0.113.7', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
      body,
    },
    { eventEmitter: EventEmitter }
  );
  await handler(req as never, res as never);
  return res;
}

function keyWithScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 1000, requestsPerDay: 10000 },
  });
}

const ROUTES: Array<{ name: string; handler: Handler; url: string; body: object; result: string; ran: () => number }> =
  [
    {
      name: 'web-search',
      handler: v1WebSearch,
      url: '/api/v1/tools/web-search',
      body: { query: 'q', num_results: 2 },
      result: 'results',
      ran: () => mockSearch.mock.calls.length,
    },
    {
      name: 'web-fetch',
      handler: v1WebFetch,
      url: '/api/v1/tools/web-fetch',
      body: { url: 'https://example.com/page' },
      result: '# T\n\npage',
      ran: () => mockWebFetch.mock.calls.length,
    },
    {
      name: 'weather',
      handler: v1Weather,
      url: '/api/v1/tools/weather',
      body: { lat: 47.6, lon: -122.3, units: 'metric' },
      result: "Right now it's 14\u00b0 in Seattle, with light rain.",
      ran: () => vi.mocked(fetch).mock.calls.length,
    },
  ];

describe('/api/v1/tools/*', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    counters.clear();
    mockResolveTrust.mockResolvedValue({ assessment: { status: 'trusted' }, settings: {} });
    mockUserFindById.mockResolvedValue(USER);
    mockKeyRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
    mockSearch.mockResolvedValue({ formattedResults: 'results' });
    mockWebFetch.mockResolvedValue({
      markdown: 'page',
      title: 'T',
      offset: 0,
      truncated: false,
      extractedChars: 4,
      originalChars: 4,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ main: { temp: 14 }, name: 'Seattle', weather: [{ description: 'light rain' }] })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe.each(ROUTES)('$name', route => {
    it.each([ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE])('runs the tool for a key holding %s', async scope => {
      keyWithScopes([scope]);
      const res = await call(route.handler, route.url, route.body, VALID_KEY);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ result: route.result });
      expect(route.ran()).toBe(1);
    });

    it('403s a key holding neither ai:chat nor ai:generate, before the tool runs', async () => {
      keyWithScopes([ApiKeyScope.READ_FILES]);
      const res = await call(route.handler, route.url, route.body, VALID_KEY);

      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE]);
      expect(route.ran()).toBe(0);
    });

    it('403s an untrusted account before the tool runs', async () => {
      mockResolveTrust.mockResolvedValue({
        assessment: { status: 'untrusted', reason: 'email_unverified' },
        settings: {},
      });
      const res = await call(route.handler, route.url, route.body);

      expect(res._getStatusCode()).toBe(403);
      expect(route.ran()).toBe(0);
    });

    it('422s a body that fails the contract schema', async () => {
      const res = await call(route.handler, route.url, {});

      expect(res._getStatusCode()).toBe(422);
      expect(route.ran()).toBe(0);
    });
  });

  it('shares one hourly budget with the SPA-internal /api/tools/* routes', async () => {
    for (let i = 0; i < TOOL_ROUTES_HOURLY_LIMIT; i++) {
      expect((await call(legacyWebSearch, '/api/tools/web-search', { query: 'q' }))._getStatusCode()).toBe(200);
    }

    const res = await call(v1WebSearch, '/api/v1/tools/web-search', { query: 'q' });
    expect(res._getStatusCode()).toBe(429);
  });
});
