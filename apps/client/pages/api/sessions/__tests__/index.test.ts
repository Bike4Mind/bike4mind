// @vitest-environment node
/**
 * /api/sessions - the notebook list (GET) and delete-every-notebook (DELETE) share one baseApi()
 * door, so the API-key scope is asserted per verb in the handler rather than by a route-level
 * requiredScopes: DELETE needs notebooks:write, GET stays open to read keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { mockFindById, mockSearchOwnSessions, mockLogEvent, mockValidate, mockRateLimit } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockSearchOwnSessions: vi.fn(),
  mockLogEvent: vi.fn(),
  mockValidate: vi.fn(),
  mockRateLimit: vi.fn(),
}));

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': '60',
  'X-RateLimit-Remaining-Minute': '59',
  'X-RateLimit-Reset-Minute': '0',
  'X-RateLimit-Limit-Day': '1000',
  'X-RateLimit-Remaining-Day': '999',
  'X-RateLimit-Reset-Day': '0',
};

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
    sessionService: {
      ...(actual.sessionService as object),
      searchOwnSessions: (...a: unknown[]) => mockSearchOwnSessions(...a),
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

import { Session } from '@bike4mind/database/auth';
import handler from '../index';

// Authenticates by API key: apiKeyAuth sets req.user and the real auth middleware then skips passport.
function fire(method: 'GET' | 'DELETE') {
  const { req, res } = createMocks(
    { method, url: '/api/sessions', headers: { 'x-api-key': 'sk-test-valid-key' } },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

function keyWithScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

describe('/api/sessions API-key scopes', () => {
  let mockDeleteMany: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    // A staged notebooks:write would turn the 403 cases into staged allows; pin it off.
    vi.stubEnv('API_KEY_SCOPE_STAGING', '');
    // apiKeyAuth calls logEvent(...).catch(...), so the stub has to be thenable.
    mockLogEvent.mockResolvedValue(undefined);
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
    mockFindById.mockResolvedValue({
      id: 'user-1',
      _id: 'user-1',
      isBanned: false,
      disputePending: false,
      aupAcceptedVersion: 'grandfathered',
    });
    mockSearchOwnSessions.mockResolvedValue({ data: [], hasMore: false });
    mockDeleteMany = vi.spyOn(Session, 'deleteMany').mockResolvedValue({ deletedCount: 3 } as never);
  });

  afterEach(() => {
    mockDeleteMany.mockRestore();
    vi.unstubAllEnvs();
  });

  it.each([
    ['a notebooks:read key', [ApiKeyScope.READ_NOTEBOOKS]],
    ['an unscoped key', []],
  ])('refuses DELETE for %s without deleting anything', async (_label, scopes) => {
    keyWithScopes(scopes);
    const { req, res } = fire('DELETE');
    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    // The message pins which gate refused: CASL's ability check would answer a bare 'Forbidden'.
    expect(JSON.stringify(res._getData())).toContain('notebooks:write is required');
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('lets a notebooks:write key delete all notebooks', async () => {
    keyWithScopes([ApiKeyScope.WRITE_NOTEBOOKS]);
    const { req, res } = fire('DELETE');
    await handler(req, res);

    expect(res._getStatusCode()).toBe(204);
    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
  });

  it('still serves the notebook list to a notebooks:read key', async () => {
    keyWithScopes([ApiKeyScope.READ_NOTEBOOKS]);
    const { req, res } = fire('GET');
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockSearchOwnSessions).toHaveBeenCalledTimes(1);
  });
});
