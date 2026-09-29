// @vitest-environment node
// Drives the real chain that nextRouteForContract assembles (validation, scopes, rate limit).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockFindById, mockRateLimit, mockCreateSession } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockCreateSession: vi.fn(),
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
  // Keep the real (pure) extractApiKeyFromHeaders - apiKeyAuth imports it now; only
  // checkApiKeyRateLimit is stubbed.
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
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
    sessionService: {
      ...(actual.sessionService as object),
      createSession: (...a: unknown[]) => mockCreateSession(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), {
      findById: (...a: unknown[]) => mockFindById(...a),
      findByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, _res: any, next: any) => {
      if (!req.user) req.user = JWT_USER;
      next();
    },
  };
});

import handler from '../index';
import { ApiKeyScope } from '@bike4mind/common';

function fire(body: unknown, { apiKey = 'sk-test-valid-key' as string | null } = {}) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/v1/sessions',
      body: body as Record<string, unknown>,
      headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

function validateWithScopes(scopes: string[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

describe('POST /api/v1/sessions (integration - contract validation and scope enforcement)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockReturnValue(
      Promise.resolve({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false })
    );
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
    mockCreateSession.mockResolvedValue({ id: 's1', name: 'N', userId: 'user-1', knowledgeIds: [], agentIds: [] });
  });

  it('rejects a key lacking notebooks:write (403)', async () => {
    validateWithScopes([ApiKeyScope.AI_CHAT]);
    const { req, res } = fire({ name: 'N' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('accepts a key holding notebooks:write', async () => {
    validateWithScopes([ApiKeyScope.WRITE_NOTEBOOKS]);
    const { req, res } = fire({ name: 'N' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: 's1' });
  });

  it('still succeeds for a JWT caller with no API key', async () => {
    const { req, res } = fire({ name: 'N' }, { apiKey: null });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
  });

  it('strips an unknown key instead of rejecting it', async () => {
    validateWithScopes([ApiKeyScope.WRITE_NOTEBOOKS]);
    const { req, res } = fire({ name: 'N', notAField: 1 });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockCreateSession.mock.calls[0][1]).not.toHaveProperty('notAField');
  });

  it('answers 422 on a wrong type', async () => {
    validateWithScopes([ApiKeyScope.WRITE_NOTEBOOKS]);
    const { req, res } = fire({ name: 'N', knowledgeIds: 'not-an-array' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});
