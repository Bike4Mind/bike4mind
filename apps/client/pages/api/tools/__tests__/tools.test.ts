// @vitest-environment node
/**
 * /api/tools/* posture: drives the real baseApi chain (same approach as
 * api/__tests__/identify.test.ts) to pin the shared hourly rate limit, the API-key scope gate
 * and the per-execution audit record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { mockValidate, mockUserFindById, mockKeyRateLimit, mockSearch, mockAuditCreate, counters } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockKeyRateLimit: vi.fn(),
  mockSearch: vi.fn(),
  mockAuditCreate: vi.fn(),
  counters: new Map<string, number>(),
}));

const USER = { id: 'user-1', _id: 'user-1', username: 'jules', tokenVersion: 0, isBanned: false };

vi.mock('@server/utils/apiKeyTrust', () => ({
  applyUntrustedRateLimit: async (_owner: unknown, key: { rateLimit: unknown }) => key.rateLimit,
}));
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockKeyRateLimit(...a),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
    apiKeyService: { ...(actual.apiKeyService as object), getOpenWeatherKey: async () => null },
  };
});
vi.mock('@bike4mind/services/llm/tools/implementation/websearch', () => ({
  performWebSearch: (...a: unknown[]) => mockSearch(...a),
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
    toolExecutionLogRepository: { create: (...a: unknown[]) => mockAuditCreate(...a) },
  };
});

vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, _res: any, next: any) => {
      if (!req.user) req.user = USER;
      next();
    },
  };
});

import webSearch from '../web-search';
import weather from '../weather';
import { TOOL_ROUTES_HOURLY_LIMIT } from '@server/middlewares/toolRoutesRateLimit';

const VALID_KEY = 'b4m_live_0123456789abcdef0123456789abcdef';
const SHARED_IP = '203.0.113.7';

// any: next-connect handlers take Express req/res; node-mocks-http mocks are not structurally those.
async function call(
  handler: (req: any, res: any) => unknown,
  url: string,
  body: object,
  apiKey?: string,
  user?: typeof USER
) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url,
      headers: { 'x-forwarded-for': SHARED_IP, ...(apiKey ? { 'x-api-key': apiKey } : {}) },
      body,
    },
    { eventEmitter: EventEmitter }
  );
  // Otherwise the auth stub below signs the request in as USER.
  if (user) req.user = user;
  await handler(req, res);
  return res;
}

const search = (apiKey?: string, user?: typeof USER) =>
  call(webSearch, '/api/tools/web-search', { query: 'q' }, apiKey, user);

function keyWithScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 1000, requestsPerDay: 10000 },
  });
}

describe('/api/tools/*', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    counters.clear();
    mockUserFindById.mockResolvedValue(USER);
    mockKeyRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
    mockSearch.mockResolvedValue({ formattedResults: 'results' });
    mockAuditCreate.mockResolvedValue({});
  });

  it('writes one tool execution log for a normal call', async () => {
    const res = await search();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ result: 'results' });
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', toolName: 'web_search', success: true })
    );
  });

  it('logs a failed execution as unsuccessful and still surfaces the error', async () => {
    mockSearch.mockRejectedValue(new Error('provider down'));
    const res = await search();

    expect(res._getStatusCode()).toBe(500);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'web_search', success: false, error: 'provider down' })
    );
  });

  it('429s the call past the hourly limit, counted across all the tool routes', async () => {
    for (let i = 0; i < TOOL_ROUTES_HOURLY_LIMIT - 1; i++) expect((await search())._getStatusCode()).toBe(200);
    expect((await call(weather, '/api/tools/weather', { lat: 1, lon: 2 }))._getStatusCode()).not.toBe(429);

    const res = await search();
    expect(res._getStatusCode()).toBe(429);
    expect(mockSearch).toHaveBeenCalledTimes(TOOL_ROUTES_HOURLY_LIMIT - 1);
  });

  it('keys the limit by user, so two users behind one IP do not share a bucket', async () => {
    const otherUser = { ...USER, id: 'user-2', _id: 'user-2', username: 'kim' };
    for (let i = 0; i < TOOL_ROUTES_HOURLY_LIMIT; i++) await search();
    expect((await search())._getStatusCode()).toBe(429);

    mockUserFindById.mockResolvedValue(otherUser);
    const res = await search(undefined, otherUser);

    expect(res._getStatusCode()).toBe(200);
    expect(mockAuditCreate).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'user-2' }));
  });

  it('403s an embed-scoped API key', async () => {
    keyWithScopes([ApiKeyScope.EMBED_CHAT]);
    const res = await search(VALID_KEY);

    expect(res._getStatusCode()).toBe(403);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('403s an API key holding no AI scope', async () => {
    keyWithScopes([ApiKeyScope.READ_FILES]);
    const res = await search(VALID_KEY);

    expect(res._getStatusCode()).toBe(403);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('admits an API key holding ai:chat', async () => {
    keyWithScopes([ApiKeyScope.AI_CHAT]);
    const res = await search(VALID_KEY);

    expect(res._getStatusCode()).toBe(200);
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
  });
});
