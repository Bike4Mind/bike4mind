// @vitest-environment node
/**
 * GET /api/google-drive/token returns a live third-party OAuth credential, so it
 * must stay off the api-key surface entirely. Drives the real `baseApi` chain to
 * prove `auth: 'jwtOnly'` is wired: a key-bearing request is rejected without the
 * key ever being validated, and no token is disclosed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockUserFindById, mockDecrypt, mockRefresh } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockDecrypt: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
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
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockUserFindById(...a) }),
  };
});

vi.mock('@server/security/tokenEncryption', () => ({
  decryptToken: (...a: unknown[]) => mockDecrypt(...a),
  encryptToken: (v: unknown) => v,
}));

vi.mock('@server/integrations/google/drive/common', () => ({
  getAuthUrl: () => 'https://accounts.google.example/authorize',
  refreshAccessToken: (...a: unknown[]) => mockRefresh(...a),
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

import handler from '../token';

const DRIVE_ACCESS_TOKEN = 'gd_live_access_token';

function fire({ apiKey, bearer }: { apiKey?: string; bearer?: string } = {}) {
  const { req, res } = createMocks(
    {
      method: 'GET',
      url: '/api/google-drive/token',
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

describe('GET /api/google-drive/token (jwtOnly)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecrypt.mockImplementation((v: string) => v);
    mockUserFindById.mockResolvedValue({
      googleDrive: {
        accessToken: DRIVE_ACCESS_TOKEN,
        refreshToken: 'gd_refresh',
        // Far future, so the handler returns the token without refreshing.
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  it('rejects an api-key caller and discloses no drive token', async () => {
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
    expect(JSON.stringify(res._getData())).not.toContain(DRIVE_ACCESS_TOKEN);
    // jwtOnly does not install apiKeyAuth at all, so the key is never even validated.
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it('still serves a JWT caller', async () => {
    const { req, res } = fire({ bearer: 'live-jwt' });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ accessToken: DRIVE_ACCESS_TOKEN });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
