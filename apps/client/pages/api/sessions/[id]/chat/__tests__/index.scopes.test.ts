// @vitest-environment node
/**
 * /api/sessions/[id]/chat - reading a notebook's messages (GET) and appending one (POST) share one
 * baseApi door that admits either notebook scope; POST then narrows to notebooks:write in the handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiKeyScope } from '@bike4mind/common';

const { mockFindById, mockGetMessages, mockAddMessage, mockLogEvent, mockValidate, mockRateLimit } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockGetMessages: vi.fn(),
  mockAddMessage: vi.fn(),
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
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

vi.mock('@bike4mind/server-utils/managers/sessionManager', () => ({
  getMessagesFromSession: (...a: unknown[]) => mockGetMessages(...a),
  addMessageToSession: (...a: unknown[]) => mockAddMessage(...a),
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

import handler from '../index';

const MESSAGE_BODY = { timestamp: '2026-01-01T00:00:00.000Z', type: 'message', prompt: 'hello' };

// Authenticates by API key: apiKeyAuth sets req.user and the real auth middleware then skips passport.
function fire(method: 'GET' | 'POST') {
  return createMocks<NextApiRequest, NextApiResponse>(
    {
      method,
      url: '/api/sessions/nb-1/chat',
      query: { id: 'nb-1' },
      headers: { 'x-api-key': 'sk-test-valid-key' },
      ...(method === 'POST' && { body: MESSAGE_BODY }),
    },
    { eventEmitter: EventEmitter }
  );
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

describe('/api/sessions/[id]/chat API-key scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A staged notebook scope would turn the 403 cases into staged allows; pin it off.
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
    mockGetMessages.mockResolvedValue({ data: [], hasMore: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves the messages to a notebooks:read key', async () => {
    keyWithScopes([ApiKeyScope.READ_NOTEBOOKS]);
    const { req, res } = fire('GET');
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockGetMessages).toHaveBeenCalledTimes(1);
  });

  // Every key is legacy until the legacy window's cutoff is set, so keys that miss the scopes still
  // pass here; the refusal they get after the window ends is pinned in apiKeyScopeGate.test.ts.
  it('lets a legacy notebooks:read key POST, as before scopes', async () => {
    keyWithScopes([ApiKeyScope.READ_NOTEBOOKS]);
    mockAddMessage.mockResolvedValue({ id: 'm1' });
    const { req, res } = fire('POST');
    await handler(req, res);

    expect(res._getStatusCode()).not.toBe(403);
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'POST'] as const)('admits %s for an admin:* key with no notebook scope', async method => {
    keyWithScopes([ApiKeyScope.ADMIN]);
    mockAddMessage.mockResolvedValue({ id: 'm1' });
    const { req, res } = fire(method);
    await handler(req, res);

    expect(res._getStatusCode()).not.toBe(403);
    expect(method === 'GET' ? mockGetMessages : mockAddMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['GET', 'an unscoped key', []],
    ['GET', 'a non-notebook key', [ApiKeyScope.ME_READ]],
    ['POST', 'an unscoped key', []],
  ] as const)('admits %s for %s while it is legacy', async (method, _label, scopes) => {
    keyWithScopes([...scopes]);
    mockAddMessage.mockResolvedValue({ id: 'm1' });
    const { req, res } = fire(method);
    await handler(req, res);

    expect(res._getStatusCode()).not.toBe(403);
    expect(method === 'GET' ? mockGetMessages : mockAddMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'POST'] as const)('refuses %s at the door for a confined key', async method => {
    keyWithScopes([ApiKeyScope.EMBED_CHAT]);
    const { req, res } = fire(method);
    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(JSON.stringify(res._getData())).toContain('Insufficient API key permissions');
    expect(mockGetMessages).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});
