import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { AuthStrategy } from '@bike4mind/common';
import { ACCOUNT_LINK_EMAIL_MISMATCH, ACCOUNT_LINK_VERIFICATION_REQUIRED } from '@server/utils/auth/oauthAccountLink';

// Middleware: collapse the baseApi chain so `.get(fn)` yields the raw handler.
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = { use: () => chain, get: (fn: any) => fn };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next?.(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: any) => next?.() }));

// Database: only User + authFailLogRepository are touched by the handler.
const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockCreate = vi.fn();
const mockAuthFailCreate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  User: {
    // findOne returns a chainable stub so production code's `.select('+password')`
    // works; the underlying resolved value (set via mockFindOne) is unaffected.
    findOne: (...a: any[]) => ({ select: () => mockFindOne(...a) }),
    updateOne: (...a: any[]) => mockUpdateOne(...a),
    create: (...a: any[]) => mockCreate(...a),
  },
  authFailLogRepository: { create: (...a: any[]) => mockAuthFailCreate(...a) },
}));

// Okta OIDC client: token exchange + userinfo are network calls, fully stubbed.
const mockGetConfig = vi.fn();
const mockExchange = vi.fn();
const mockFetchUserInfo = vi.fn();
vi.mock('@server/auth/oktaOidcClient', () => ({
  getOktaConfigWithFallback: (...a: any[]) => mockGetConfig(...a),
  exchangeCodeForTokens: (...a: any[]) => mockExchange(...a),
  fetchUserInfo: (...a: any[]) => mockFetchUserInfo(...a),
}));

// State token verification.
const mockVerifyState = vi.fn();
vi.mock('@server/auth/jwtStateStore', () => ({ verifyStateToken: (...a: any[]) => mockVerifyState(...a) }));

// Remaining leaf collaborators.
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: {
    createAccessToken: () => ({ accessToken: 'jwt-access', refreshToken: 'jwt-refresh' }),
  },
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/auth/requireNonSystemUser', () => ({ requireNonSystemUser: vi.fn() }));
vi.mock('@server/utils/validators', () => ({ validateAppUrl: () => 'http://localhost:3000' }));
vi.mock('@server/security/secretEncryption', () => ({ encryptSecret: (v: string) => `enc:${v}` }));
vi.mock('@server/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: undefined } }));
vi.mock('@bike4mind/observability', () => ({
  Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks are registered.
import handler from '@pages/api/auth/okta/callback';

const STATE = 'state-token';
const CODE = 'auth-code';

function makeReqRes() {
  const { req, res } = createMocks({
    method: 'GET',
    query: { state: STATE, code: CODE },
    headers: { host: 'localhost:3000', 'user-agent': 'vitest' },
    url: '/api/auth/okta/callback',
  });
  return { req: req as any, res: res as any };
}

/** Drive the handler with a given existing-user record and Okta userinfo. */
async function runCallback(opts: { user: any; userInfo: Record<string, unknown> }) {
  mockFindOne.mockResolvedValue(opts.user);
  mockFetchUserInfo.mockResolvedValue({ sub: 'okta-sub-default', ...opts.userInfo });
  const { req, res } = makeReqRes();
  await handler(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = 'http://localhost:3000';

  mockVerifyState.mockReturnValue({
    valid: true,
    payload: { idpId: 'idp-1', codeVerifier: 'pkce-verifier' },
  });
  mockGetConfig.mockResolvedValue({
    config: { issuer: 'https://okta.example.com' },
    source: 'idp',
    idp: { id: 'idp-1' },
  });
  mockExchange.mockResolvedValue({
    accessToken: 'okta-access',
    tokenResponse: { claims: () => ({ sub: 'okta-sub-default' }), refresh_token: 'okta-refresh' },
  });
  mockUpdateOne.mockResolvedValue({});
  mockCreate.mockResolvedValue({ id: 'new-user', _id: 'new-user', tokenVersion: 0, isBanned: false });
});

describe('/api/auth/okta/callback — account-link email-equality gate', () => {
  it('refuses to auto-link when both emails are verified but do NOT match', async () => {
    const res = await runCallback({
      user: {
        id: 'u1',
        _id: 'u1',
        email: 'victim@example.com',
        emailVerified: true,
        authProviders: [],
        tokenVersion: 0,
      },
      userInfo: {
        sub: 'okta-attacker',
        email: 'attacker@example.com',
        email_verified: true,
        preferred_username: 'victim',
      },
    });

    expect(res._getRedirectUrl()).toContain(ACCOUNT_LINK_EMAIL_MISMATCH);
    expect(mockAuthFailCreate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: ACCOUNT_LINK_EMAIL_MISMATCH, email: 'attacker@example.com', strategy: 'okta' })
    );
    // The account must not be mutated when the gate refuses the link.
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('allows auto-link when verified emails match case-insensitively, bumping tokenVersion', async () => {
    const res = await runCallback({
      user: { id: 'u2', _id: 'u2', email: 'User@Example.com', emailVerified: true, authProviders: [], tokenVersion: 3 },
      userInfo: { sub: 'okta-1', email: 'user@example.com', email_verified: true, preferred_username: 'user' },
    });

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    // New provider link: tokenVersion incremented to invalidate other sessions.
    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'u2' }, expect.objectContaining({ $inc: { tokenVersion: 1 } }));
    expect(mockAuthFailCreate).not.toHaveBeenCalled();
  });

  it('exempts a same-identity refresh from the gate (mismatch allowed on re-login)', async () => {
    const res = await runCallback({
      user: {
        id: 'u3',
        _id: 'u3',
        email: 'user@example.com',
        emailVerified: true,
        tokenVersion: 5,
        authProviders: [{ strategy: AuthStrategy.Okta, id: 'okta-1', oktaIdentityProviderId: 'idp-1' }],
      },
      // Email differs AND is unverified - would trip both gates if not exempt.
      userInfo: { sub: 'okta-1', email: 'changed@example.com', email_verified: false, preferred_username: 'user' },
    });

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(mockAuthFailCreate).not.toHaveBeenCalled();
    // Routine refresh must NOT bump tokenVersion.
    const updateArg = mockUpdateOne.mock.calls[0]?.[1] ?? {};
    expect(updateArg).not.toHaveProperty('$inc');
  });

  it('still enforces the local-verified gate when the account HAS a password (regression)', async () => {
    // Local email unverified AND account has a password (reverse-takeover risk) -
    // must be refused even though the emails match.
    const res = await runCallback({
      user: {
        id: 'u4',
        _id: 'u4',
        email: 'user@example.com',
        emailVerified: false,
        password: 'bcrypt-hash',
        authProviders: [],
        tokenVersion: 0,
      },
      userInfo: { sub: 'okta-2', email: 'user@example.com', email_verified: true, preferred_username: 'user' },
    });

    expect(res._getRedirectUrl()).toContain(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(res._getRedirectUrl()).not.toContain(ACCOUNT_LINK_EMAIL_MISMATCH);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('links AND promotes emailVerified when the local account has no password (pure-OAuth shell)', async () => {
    const res = await runCallback({
      user: {
        id: 'u5',
        _id: 'u5',
        email: 'user@example.com',
        emailVerified: false,
        password: null,
        authProviders: [],
        tokenVersion: 0,
      },
      userInfo: { sub: 'okta-3', email: 'user@example.com', email_verified: true, preferred_username: 'user' },
    });

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(mockAuthFailCreate).not.toHaveBeenCalled();
    const updateArg = mockUpdateOne.mock.calls[0][1];
    expect(updateArg.$set.emailVerified).toBe(true);
    expect(updateArg.$set.emailVerifiedAt).toBeInstanceOf(Date);
    expect(updateArg.$inc).toEqual({ tokenVersion: 1 });
  });

  it('creates a brand-new user when no existing account matches (gate does not apply)', async () => {
    const res = await runCallback({
      user: null,
      userInfo: {
        sub: 'okta-new',
        email: 'new@example.com',
        email_verified: true,
        preferred_username: 'newbie',
        name: 'New Bie',
      },
    });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@example.com' }));
    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(mockAuthFailCreate).not.toHaveBeenCalled();
  });
});
