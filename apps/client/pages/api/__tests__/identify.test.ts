// @vitest-environment node
/**
 * Integration test for GET /api/identify.
 *
 * Drives the real next-connect chain `baseApi` assembles (same approach as
 * ai/__tests__/generate-image.integration.test.ts) to prove the properties that keep
 * identify from being traded for account control: no caller (API key, full session or
 * a session still awaiting its second factor) is minted a browser session or refresh
 * cookie, and no caller receives the raw User document.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockUserFindById, mockRateLimit, mockIssueSession } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockIssueSession: vi.fn(),
}));

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': '60',
  'X-RateLimit-Remaining-Minute': '59',
  'X-RateLimit-Reset-Minute': '0',
  'X-RateLimit-Limit-Day': '1000',
  'X-RateLimit-Remaining-Day': '999',
  'X-RateLimit-Reset-Day': '0',
};

vi.mock('@server/utils/apiKeyTrust', () => ({
  applyUntrustedRateLimit: async (_owner: unknown, key: { rateLimit: unknown }) => key.rateLimit,
}));
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  // Keep the real (pure) extractApiKeyFromHeaders - apiKeyAuth imports it.
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
  };
});

/**
 * The user carries one field from every redaction family the sanitizer handles:
 * outright-deleted (oauthCredentials, securityQuestions, loginRecords) and
 * subfield-rebuilt (authProviders, googleDrive).
 */
const SECRETS = {
  oauthCredentials: { github: 'ghp_secret_value' },
  securityQuestions: [{ question: 'first pet', answer: 'mittens' }],
  loginRecords: [{ ip: '203.0.113.7', at: new Date(0) }],
  authProviders: [{ id: 'goog-sub-1', strategy: 'google', accessToken: 'ya29.secret_value' }],
  googleDrive: { accessToken: 'gd_secret_value', refreshToken: 'gd_refresh_value', expiresAt: new Date(0) },
};
const USER = {
  id: 'user-1',
  _id: 'user-1',
  username: 'jules',
  email: 'jules@example.com',
  tokenVersion: 0,
  isBanned: false,
  disputePending: false,
  ...SECRETS,
};

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockUserFindById(...a) }),
  };
});

// Tripwire: identify must never reach a session mint, whoever the caller is.
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: (...a: unknown[]) => mockIssueSession(...a),
}));

// The per-user throttle is backed by the `caches` collection; this test has no Mongo.
vi.mock('@server/middlewares/rateLimit', () => ({
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

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

import handler from '../identify';
import { ApiKeyScope } from '@bike4mind/common';

const VALID_KEY = 'b4m_live_0123456789abcdef0123456789abcdef';

function fire({
  apiKey,
  bearer,
  authorization = bearer ? `Bearer ${bearer}` : undefined,
}: { apiKey?: string; bearer?: string; authorization?: string } = {}) {
  const { req, res } = createMocks(
    {
      method: 'GET',
      url: '/api/identify',
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(authorization ? { authorization } : {}),
      },
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

function validateWithScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

/** Every secret value that must never appear anywhere in the response. */
const SECRET_VALUES = [
  'ghp_secret_value',
  'mittens',
  '203.0.113.7',
  'ya29.secret_value',
  'gd_secret_value',
  'gd_refresh_value',
];

describe('GET /api/identify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue(USER);
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
    mockIssueSession.mockResolvedValue({ accessToken: 'jwt-access', sid: 'sid-1' });
  });

  describe('api-key caller', () => {
    it('mints no session, returns no accessToken and sets no refresh cookie', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ apiKey: VALID_KEY });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(mockIssueSession).not.toHaveBeenCalled();
      expect(res._getJSONData().accessToken).toBeUndefined();
      expect(res.getHeader('set-cookie')).toBeUndefined();
    });

    it('returns a whoami stripped of every secret field', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ apiKey: VALID_KEY });
      await handler(req, res);

      const { user } = res._getJSONData();
      expect(user).toMatchObject({ id: 'user-1', username: 'jules' });
      expect(user.oauthCredentials).toBeUndefined();
      expect(user.securityQuestions).toBeUndefined();
      expect(user.loginRecords).toBeUndefined();
      // authProviders is rebuilt per-provider by an { id, strategy } allowlist: the OAuth
      // tokens are dropped but the provider identity survives so the linked-account
      // indicator still renders.
      expect(user.authProviders).toEqual([{ id: 'goog-sub-1', strategy: 'google' }]);
      // googleDrive is rebuilt as status-only metadata, so the tokens are gone but
      // the connected-state the UI reads survives.
      expect(user.googleDrive?.accessToken).toBeUndefined();
      expect(user.googleDrive?.refreshToken).toBeUndefined();

      const body = JSON.stringify(res._getJSONData());
      for (const secret of SECRET_VALUES) expect(body).not.toContain(secret);
    });

    it('does not echo a bearer back when the request also carries one', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ apiKey: VALID_KEY, bearer: 'someone-elses-jwt' });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().accessToken).toBeUndefined();
      expect(mockIssueSession).not.toHaveBeenCalled();
    });

    it('403s a confined key before the handler runs at all', async () => {
      validateWithScopes([ApiKeyScope.EMBED_CHAT]);
      const { req, res } = fire({ apiKey: VALID_KEY });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(403);
      expect(mockIssueSession).not.toHaveBeenCalled();
    });
  });

  describe('jwt caller', () => {
    function fireAs(user: typeof USER & { mfaPending?: boolean }, options?: Parameters<typeof fire>[0]) {
      const fired = fire(options);
      fired.req.user = user;
      return fired;
    }

    it.each([
      ['a full session', USER],
      ['a session awaiting its second factor', { ...USER, mfaPending: true }],
    ])('echoes the token and mints nothing for %s', async (_label, user) => {
      const { req, res } = fireAs(user, { bearer: 'live-jwt' });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(mockIssueSession).not.toHaveBeenCalled();
      expect(res._getJSONData().accessToken).toBe('live-jwt');
      expect(res.getHeader('set-cookie')).toBeUndefined();
      expect(mockValidate).not.toHaveBeenCalled();
    });

    it('mints nothing when it reads no bearer token from the request', async () => {
      const { req, res } = fireAs({ ...USER, mfaPending: true });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(mockIssueSession).not.toHaveBeenCalled();
      expect(res._getJSONData().accessToken).toBeUndefined();
      expect(res.getHeader('set-cookie')).toBeUndefined();
    });

    // The jwt strategy accepts any whitespace between scheme and token; the echoed token must
    // be the one it authenticated, not an empty string from a single-space split.
    it.each([
      ['a doubled space', 'Bearer  live-jwt'],
      ['a tab', 'Bearer\tlive-jwt'],
      ['a lowercase scheme', 'bearer live-jwt'],
    ])('echoes the authenticated token when the header uses %s', async (_label, authorization) => {
      const { req, res } = fire({ authorization });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().accessToken).toBe('live-jwt');
    });

    it('is sanitized too - the raw document never leaves this route', async () => {
      const { req, res } = fire();
      await handler(req, res);

      const body = JSON.stringify(res._getJSONData());
      for (const secret of SECRET_VALUES) expect(body).not.toContain(secret);
    });
  });
});
