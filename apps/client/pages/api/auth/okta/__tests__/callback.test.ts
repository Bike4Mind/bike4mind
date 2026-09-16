import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { AuthStrategy } from '@bike4mind/common';
import { ACCOUNT_LINK_EMAIL_MISMATCH, ACCOUNT_LINK_VERIFICATION_REQUIRED } from '@server/utils/auth/oauthAccountLink';
import { IDP_EMAIL_DOMAIN_MISMATCH } from '@server/utils/auth/idpEmailDomain';

// Middleware: collapse the baseApi chain so `.get(fn)` yields the raw handler.
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = { use: () => chain, get: (fn: any) => fn };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next?.(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: any) => next?.() }));

// Database: only User + authFailLogRepository + authSessionRepository are touched by the handler.
const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockCreate = vi.fn();
const mockAuthFailCreate = vi.fn();
const mockRevokeAllByUserId = vi.fn();
vi.mock('@bike4mind/database', () => ({
  User: {
    findOne: (...a: any[]) => mockFindOne(...a),
    updateOne: (...a: any[]) => mockUpdateOne(...a),
    create: (...a: any[]) => mockCreate(...a),
  },
  authFailLogRepository: { create: (...a: any[]) => mockAuthFailCreate(...a) },
  authSessionRepository: { revokeAllByUserId: (...a: any[]) => mockRevokeAllByUserId(...a) },
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

// Remaining leaf collaborators. Mock the session helper directly (rather than @bike4mind/services)
// so the test never pulls the real services barrel -- the callback mints via issueBrowserSession,
// which also sets the refresh cookie (so no refresh token appears in the redirect fragment).
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: vi.fn().mockResolvedValue({ accessToken: 'jwt-access', sid: 'sid' }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/auth/requireNonSystemUser', () => ({ requireNonSystemUser: vi.fn() }));
vi.mock('@server/utils/validators', () => ({
  validateAppUrl: () => 'http://localhost:3000',
  // The route now shares one localhost predicate with csrfProtection; the real
  // implementation is pure, so mirror it rather than stubbing a boolean.
  isLocalAppUrl: (u?: string) => {
    try {
      return ['localhost', '127.0.0.1', '0.0.0.0'].includes(new URL(u ?? process.env.APP_URL ?? '').hostname);
    } catch {
      return false;
    }
  },
}));
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
    // PKCE verifier now rides a browser-bound cookie, not the state token.
    headers: { host: 'localhost:3000', 'user-agent': 'vitest', cookie: 'b4m_okta_pkce=pkce-verifier' },
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
    payload: { idpId: 'idp-1' },
  });
  // The IDP is registered for example.com, which every email in this file belongs to,
  // so the domain bind passes and the tests below exercise what they mean to.
  mockGetConfig.mockResolvedValue({
    config: { issuer: 'https://okta.example.com' },
    source: 'idp',
    idp: { id: 'idp-1', emailDomain: 'example.com' },
  });
  mockExchange.mockResolvedValue({
    accessToken: 'okta-access',
    tokenResponse: { claims: () => ({ sub: 'okta-sub-default' }), refresh_token: 'okta-refresh' },
  });
  mockUpdateOne.mockResolvedValue({});
  mockCreate.mockResolvedValue({ id: 'new-user', _id: 'new-user', tokenVersion: 0, isBanned: false });
  mockRevokeAllByUserId.mockResolvedValue(0);
  // Default both lookup stages to "no match" so tests that drive the handler
  // directly (rather than through runCallback) exercise the create path.
  mockFindOne.mockResolvedValue(null);
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
    // ...and the paired AuthSession revoke fires, or opaque refresh tokens would survive the bump.
    expect(mockRevokeAllByUserId).toHaveBeenCalledWith('u2');
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
    // Routine refresh must NOT bump tokenVersion nor revoke existing sessions.
    const updateArg = mockUpdateOne.mock.calls[0]?.[1] ?? {};
    expect(updateArg).not.toHaveProperty('$inc');
    expect(mockRevokeAllByUserId).not.toHaveBeenCalled();
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
        hasUsablePassword: true,
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
        hasUsablePassword: false,
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

  it('refuses to promote/link on a username-only match with a null local email (takeover guard)', async () => {
    // Matched by preferred_username, not email (local email is null). A username
    // collision is not an identity assertion, so promoting would let a colliding
    // username take over the emailless passwordless shell - refuse.
    const res = await runCallback({
      user: {
        id: 'u6',
        _id: 'u6',
        email: null,
        username: 'victim',
        emailVerified: false,
        hasUsablePassword: false,
        authProviders: [],
        tokenVersion: 0,
      },
      userInfo: { sub: 'okta-6', email: 'attacker@example.com', email_verified: true, preferred_username: 'victim' },
    });

    expect(res._getRedirectUrl()).toContain(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
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

describe('/api/auth/okta/callback - new-account email verification gate', () => {
  it('persists the email when the provider asserts email_verified === true', async () => {
    await runCallback({
      user: null,
      userInfo: { sub: 'okta-v', email: 'verified@example.com', email_verified: true, name: 'Ver Ified' },
    });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'verified@example.com' }));
  });

  it('creates the account WITHOUT an email when email_verified is false', async () => {
    const res = await runCallback({
      user: null,
      userInfo: { sub: 'okta-u', email: 'unverified@example.com', email_verified: false, name: 'Un Verified' },
    });

    // Sign-in still succeeds, but the unverified email is never written as a login identity.
    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].email).toBeUndefined();
  });

  it('creates the account WITHOUT an email when the email_verified claim is absent', async () => {
    const res = await runCallback({
      user: null,
      userInfo: { sub: 'okta-a', email: 'noclaim@example.com', name: 'No Claim' },
    });

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].email).toBeUndefined();
  });

  it('still rejects (does not create) when the email itself is absent', async () => {
    const res = await runCallback({
      user: null,
      userInfo: { sub: 'okta-none', email_verified: true, name: 'No Email' },
    });

    // The pre-create email-required guard is untouched by the verification gate.
    expect(res._getRedirectUrl()).toContain('email_required');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('/api/auth/okta/callback - re-login finds the emailless account by sub (regression)', () => {
  it('re-finds an unverified-email account on the second sign-in instead of re-creating', async () => {
    // Unverified email + only a `name` claim (no preferred_username): the normal
    // Okta case. The email is dropped on create, so the account has no email login
    // identity and its username is the display name.
    mockFetchUserInfo.mockResolvedValue({
      sub: 'okta-relogin',
      email: 'unverified@example.com',
      email_verified: false,
      name: 'Re Login',
    });

    // Model the DB: create seeds the account; Stage 1 (sub) then finds it, while
    // Stage 2 (email/username $or) never matches an emailless account whose display
    // name is not queried. This is what makes the test fail before the fix - without
    // the Stage-1 sub lookup only Stage 2 runs, misses, and re-enters create.
    let account: any = null;
    mockFindOne.mockImplementation(async (query: any) => {
      if (query?.authProviders?.$elemMatch) return account;
      return null;
    });
    mockCreate.mockImplementation(async (doc: any) => {
      account = {
        id: 'created-1',
        _id: 'created-1',
        tokenVersion: 0,
        isBanned: false,
        // Read back the authProviders the create branch actually wrote
        // (createUniqueOAuthUser stores authProviders: [oauthCredentials]) rather
        // than synthesizing them, so the test exercises the real create shape the
        // Stage-1 re-find depends on.
        authProviders: doc.authProviders,
      };
      return account;
    });

    // First sign-in: no existing account -> create, with no email persisted.
    const first = makeReqRes();
    await handler(first.req, first.res);
    expect(first.res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].email).toBeUndefined();

    // Second sign-in: re-found by sub, signed into the SAME account, no second create.
    const second = makeReqRes();
    await handler(second.req, second.res);
    expect(second.res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockAuthFailCreate).not.toHaveBeenCalled();
    // The Stage-1 lookup keys on the immutable provider identity.
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        authProviders: {
          $elemMatch: { strategy: AuthStrategy.Okta, id: 'okta-relogin', oktaIdentityProviderId: 'idp-1' },
        },
      })
    );
  });
});

describe('/api/auth/okta/callback - backfill emailless account on later verified login', () => {
  /** An account created emailless (unverified at signup), now re-found by Stage 1. */
  const emaillessAccount = {
    id: 'u-backfill',
    _id: 'u-backfill',
    email: null,
    emailVerified: false,
    tokenVersion: 2,
    authProviders: [{ strategy: AuthStrategy.Okta, id: 'okta-bf', oktaIdentityProviderId: 'idp-1' }],
  };

  it('adopts the provider email once the same identity re-logs in with email_verified === true', async () => {
    const res = await runCallback({
      user: emaillessAccount,
      userInfo: { sub: 'okta-bf', email: 'now-verified@example.com', email_verified: true, preferred_username: 'user' },
    });

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    // Same-identity refresh: no tokenVersion bump, but the verified email is written.
    const updateArg = mockUpdateOne.mock.calls[0][1];
    expect(updateArg.email).toBe('now-verified@example.com');
    expect(updateArg).not.toHaveProperty('$inc');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAuthFailCreate).not.toHaveBeenCalled();
  });

  it('does NOT backfill when the re-login still does not assert email_verified', async () => {
    const res = await runCallback({
      user: emaillessAccount,
      userInfo: {
        sub: 'okta-bf',
        email: 'still-unverified@example.com',
        email_verified: false,
        preferred_username: 'user',
      },
    });

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    const updateArg = mockUpdateOne.mock.calls[0][1];
    expect(updateArg.email).toBeUndefined();
  });
});

describe('/api/auth/okta/callback - new-account create guards (username dedupe + empty name)', () => {
  it('retries with a disambiguated username on a username collision instead of E11000-ing', async () => {
    mockFetchUserInfo.mockResolvedValue({
      sub: 'okta-dup',
      email: 'dup@example.com',
      email_verified: true,
      name: 'Dup Name',
    });
    const usernameDup = Object.assign(new Error('E11000 dup key: index users.username_1'), {
      code: 11000,
      keyPattern: { username: 1 },
    });
    mockCreate
      .mockRejectedValueOnce(usernameDup)
      .mockResolvedValueOnce({ id: 'created', _id: 'created', tokenVersion: 0, isBanned: false });

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockAuthFailCreate).not.toHaveBeenCalled();
  });

  it('derives a non-empty username from the email when the provider sends no name or handle', async () => {
    // Only a verified email - no name, no preferred_username. A bare
    // User.create({ username: name }) would attempt username='' and fail
    // validation; the shared helper falls back to the email local-part.
    mockFetchUserInfo.mockResolvedValue({ sub: 'okta-noname', email: 'lonely@example.com', email_verified: true });

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.username).toBe('lonely');
    expect(createArg.name).toBe('lonely');
  });
});

describe('/api/auth/okta/callback - IDP email-domain bind', () => {
  const victim = {
    id: 'victim-1',
    _id: 'victim-1',
    email: 'victim@b.example',
    emailVerified: true,
    isAdmin: true,
    authProviders: [],
    tokenVersion: 0,
  };

  /** Point the resolved config at IdP A while the assertion names an IdP B address. */
  function useIdpA() {
    mockGetConfig.mockResolvedValue({
      config: { issuer: 'https://a.okta.example' },
      source: 'idp',
      idp: { id: 'idp-a', emailDomain: 'a.example' },
    });
  }

  it('refuses an IDP asserting an email registered to a different IDP', async () => {
    useIdpA();
    const res = await runCallback({
      user: victim,
      userInfo: { sub: 'okta-attacker', email: 'victim@b.example', email_verified: true },
    });

    expect(res._getRedirectUrl()).toContain(IDP_EMAIL_DOMAIN_MISMATCH);
    // Refused before the account is even looked up, let alone linked or signed in.
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAuthFailCreate).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'okta', email: 'victim@b.example', reason: IDP_EMAIL_DOMAIN_MISMATCH })
    );
  });

  it('refuses a subdomain of the registered domain', async () => {
    useIdpA();
    const res = await runCallback({
      user: null,
      userInfo: { sub: 'okta-sub', email: 'user@eu.a.example', email_verified: true },
    });

    expect(res._getRedirectUrl()).toContain(IDP_EMAIL_DOMAIN_MISMATCH);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('allows an email inside the registered domain', async () => {
    useIdpA();
    const res = await runCallback({
      user: null,
      userInfo: { sub: 'okta-sub', email: 'user@a.example', email_verified: true, name: 'A User' },
    });

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'user@a.example' }));
  });

  it('leaves the SST-secret fallback unbound (no IDP record to bind to)', async () => {
    mockGetConfig.mockResolvedValue({
      config: { issuer: 'https://okta.example.com' },
      source: 'sst',
      idp: undefined,
    });

    const res = await runCallback({
      user: null,
      userInfo: { sub: 'okta-sst', email: 'anyone@wherever.example', email_verified: true, name: 'SST User' },
    });

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    // Stage 1 for the unbound fallback queries WITHOUT oktaIdentityProviderId
    // (idpScope = {}), matching the shape the SST-fallback create branch writes.
    expect(mockFindOne).toHaveBeenCalledWith({
      authProviders: { $elemMatch: { strategy: AuthStrategy.Okta, id: 'okta-sst' } },
    });
  });
});
