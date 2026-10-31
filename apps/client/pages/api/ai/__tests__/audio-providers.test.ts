// @vitest-environment node
/**
 * GET /api/ai/audio-providers decides whether Studio shows its Speech and Sound effects tabs, so it must
 * stay off the api-key surface. Drives the real `baseApi` chain (as google-drive/token.test.ts does) to
 * prove `auth: 'jwtOnly'` is wired: a key-bearing request is rejected without the key ever being validated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockList, mockValidate } = vi.hoisted(() => ({ mockList: vi.fn(), mockValidate: vi.fn() }));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/listUsableAudioProviders', () => ({
  listUsableAudioProviders: (...a: unknown[]) => mockList(...a),
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

vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, res: any, next: any) => {
      // Mirror the real verifier: no bearer means no session, so the route 401s.
      if (!req.headers?.authorization) return res.status(401).json({ error: 'Unauthorized' });
      if (!req.user) req.user = JWT_USER;
      next();
    },
  };
});

import handler from '../audio-providers';

const PROVIDERS = { speech: ['openai'], soundEffects: ['elevenlabs'] };

function fire({ apiKey, bearer }: { apiKey?: string; bearer?: string } = {}) {
  const { req, res } = createMocks(
    {
      method: 'GET',
      url: '/api/ai/audio-providers',
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

describe('GET /api/ai/audio-providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue(PROVIDERS);
  });

  it('lists the signed-in user their own providers', async () => {
    const { req, res } = fire({ bearer: 'live-jwt' });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(PROVIDERS);
    expect(mockList).toHaveBeenCalledWith('jwt-user');
  });

  it('rejects an api-key caller without looking a key up', async () => {
    mockValidate.mockResolvedValue({
      isValid: true,
      keyId: 'k1',
      userId: 'user-1',
      scopes: ['ai:chat'],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    const { req, res } = fire({ apiKey: 'b4m_live_0123456789abcdef0123456789abcdef' });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(401);
    // jwtOnly does not install apiKeyAuth at all, so the key is never even validated.
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });
});
