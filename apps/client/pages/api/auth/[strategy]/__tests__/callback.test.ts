import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Middleware: collapse the baseApi chain so `.get(fn)` yields the raw handler,
// mirroring apps/client/pages/api/auth/okta/__tests__/callback.test.ts.
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = { use: () => chain, get: (fn: any) => fn };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next?.(),
}));

// passport.authenticate is invoked as passport.authenticate(strategy, opts, cb)(req, res, next);
// the mock lets each test drive the (err, user, info) triple passport would normally supply.
const mockAuthenticate = vi.fn();
vi.mock('passport', () => ({
  default: { authenticate: (...args: any[]) => mockAuthenticate(...args) },
}));

const mockAuthFailCreate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  authFailLogRepository: { create: (...a: any[]) => mockAuthFailCreate(...a) },
}));

vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: {
    createAccessToken: () => ({ accessToken: 'jwt-access', refreshToken: 'jwt-refresh' }),
  },
}));
vi.mock('@server/auth/jwtStateStore', () => ({ verifyStateToken: vi.fn() }));
vi.mock('@server/auth/authSuccessRedirect', () => ({ authSuccessRedirectQuery: () => '' }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));

const mockEmitSignup = vi.fn().mockResolvedValue([]);
vi.mock('@server/analytics/signupEvents', () => ({
  emitSignupForSourceProducts: (...a: any[]) => mockEmitSignup(...a),
}));

const mockIssueBrowserSession = vi.fn().mockResolvedValue({ accessToken: 'jwt-access', sid: 'sid' });
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: (...a: any[]) => mockIssueBrowserSession(...a),
}));

// Import after mocks are registered.
import { logEvent } from '@server/utils/analyticsLog';
import handler from '@pages/api/auth/[strategy]/callback';

function makeReqRes(headers: Record<string, string> = {}) {
  const { req, res } = createMocks({
    method: 'GET',
    query: { strategy: 'github', state: 'state-token' },
    headers: { host: 'localhost:3000', 'user-agent': 'vitest', ...headers },
    url: '/api/auth/github/callback',
  });
  return { req: req as any, res: res as any };
}

/** Drive the handler as if passport's verify callback resolved with (err, user, info). */
async function runCallback(err: unknown, user: unknown, info: unknown, headers?: Record<string, string>) {
  // The handler does not await passport's callback, so hold on to the promise it returns and wait
  // for that: a fixed tick races any await added above the code under test.
  let passportCallback: Promise<unknown> | undefined;
  mockAuthenticate.mockImplementation((_strategy: string, _opts: any, cb: any) => () => {
    passportCallback = cb(err, user, info);
  });
  const { req, res } = makeReqRes(headers);
  await handler(req, res, vi.fn());
  await passportCallback;
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[strategy]/callback - !user branch sanitized reason', () => {
  it('maps a thrown E11000 duplicate-key error to duplicate_account and never leaks the raw Mongo text or embedded victim email', async () => {
    const rawMongoText = 'E11000 duplicate key error dup key: { username: "victim@example.com" }';
    const res = await runCallback(null, undefined, { code: 'duplicate_account', message: rawMongoText });

    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'duplicate_account' }));
    const loggedArg = mockAuthFailCreate.mock.calls[0][0];
    expect(JSON.stringify(loggedArg)).not.toContain('victim@example.com');
    expect(JSON.stringify(loggedArg)).not.toContain('E11000');

    const redirectUrl = res._getRedirectUrl();
    expect(redirectUrl).toBe('/login?error=Authentication%20failed');
    expect(redirectUrl).not.toContain('victim');
    expect(redirectUrl).not.toContain('E11000');
  });

  it('maps state_expired to a distinct canonical reason with a friendly retry redirect', async () => {
    const res = await runCallback(null, undefined, {
      code: 'state_expired',
      message: 'Authorization request expired. Please try again.',
    });

    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state_expired' }));
    expect(res._getRedirectUrl()).toBe(
      `/login?error=${encodeURIComponent('Your login request expired. Please try again.')}`
    );
  });

  it('maps state_missing and state_invalid to their own distinct canonical reasons', async () => {
    const missingRes = await runCallback(null, undefined, {
      code: 'state_missing',
      message: 'Missing state parameter',
    });
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state_missing' }));
    expect(missingRes._getRedirectUrl()).toBe('/login?error=Authentication%20failed');

    vi.clearAllMocks();

    const invalidRes = await runCallback(null, undefined, {
      code: 'state_invalid',
      message: 'Invalid authorization state.',
    });
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state_invalid' }));
    expect(invalidRes._getRedirectUrl()).toBe('/login?error=Authentication%20failed');
  });

  it('default-denies an unrecognized or absent code to internal - raw info.message never substitutes for reason', async () => {
    const withUnknownCode = await runCallback(null, undefined, {
      code: 'some_new_unwhitelisted_code',
      message: 'irrelevant',
    });
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'internal' }));

    vi.clearAllMocks();

    const withNoInfo = await runCallback(null, undefined, undefined);
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'internal' }));
    expect(withNoInfo._getRedirectUrl()).toBe('/login?error=Authentication%20failed');
    void withUnknownCode;
  });

  it('maps forbidden_system_user to its own distinct canonical reason', async () => {
    const res = await runCallback(null, undefined, {
      code: 'forbidden_system_user',
      message: 'Cannot authenticate as a system account',
    });

    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'forbidden_system_user' }));
    expect(res._getRedirectUrl()).toBe('/login?error=Authentication%20failed');
  });
});

describe('[strategy]/callback - banned user gate', () => {
  it('refuses to issue a session for a banned user and records the refusal', async () => {
    const res = await runCallback(null, { id: 'u-banned', email: 'banned@example.com', isBanned: true }, undefined);

    expect(res._getRedirectUrl()).toBe('/login?error=account_suspended');
    expect(mockAuthFailCreate).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'github', reason: 'user_banned', email: 'banned@example.com' })
    );
    expect(mockIssueBrowserSession).not.toHaveBeenCalled();
  });

  it('still signs in a user who is not banned', async () => {
    const res = await runCallback(null, { id: 'u-ok', email: 'ok@example.com', isBanned: false }, undefined);
    // The handler does not await passport's callback, and the success path awaits more
    // than the refusal paths do, so let its remaining microtasks drain before asserting.

    expect(mockIssueBrowserSession).toHaveBeenCalled();
    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
  });
});

describe('[strategy]/callback - invite gate', () => {
  it('surfaces registration_closed with an invite-only message', async () => {
    const res = await runCallback(null, undefined, { code: 'registration_closed' });

    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'registration_closed' }));
    expect(res._getRedirectUrl()).toBe(
      `/login?error=${encodeURIComponent('This instance is invite-only. Ask an administrator for an invite.')}`
    );
  });
});

describe('[strategy]/callback - signup credited to the source product', () => {
  const touch = `b4m_last_touch=${encodeURIComponent(JSON.stringify({ source: 'widgets', medium: 'landing' }))}`;
  // Attribution is gated server-side on a consent decision, so a touch cookie alone is not
  // enough to emit - see readConsentedAcquisitionTouches.
  const touchCookie = `${touch}; b4m-consent-decision=granted`;

  it("sends a new account's touches, read from its own cookies, with the provider as the method", async () => {
    const res = await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, {
      cookie: touchCookie,
    });

    expect(mockEmitSignup).toHaveBeenCalledWith({
      userId: 'u-new',
      touches: { lastTouch: { source: 'widgets', medium: 'landing' } },
      method: 'github',
    });
    expect(res._getRedirectUrl()).toMatch(/isNewUser=1/);
  });

  it('sends nothing for a returning user', async () => {
    await runCallback(null, { id: 'u-old', isBanned: false }, undefined, { cookie: touchCookie });

    expect(mockIssueBrowserSession).toHaveBeenCalled();
    expect(mockEmitSignup).not.toHaveBeenCalled();
  });

  // The REGISTER log and the emit are separate statements; folding the emit into the log's
  // try/catch would drop a signup whenever the log write fails.
  it('still sends the signup when the REGISTER log fails', async () => {
    vi.mocked(logEvent).mockRejectedValueOnce(new Error('log store down'));

    const res = await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, {
      cookie: touchCookie,
    });

    expect(mockEmitSignup).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-new', method: 'github' }));
    expect(res._getRedirectUrl()).toMatch(/isNewUser=1/);
  });

  // The account exists once verifyCallback returns, and a retry sees isNewUser false, so a
  // signup not sent before the session mint is never sent at all.
  it('still sends the signup when minting the session fails', async () => {
    mockIssueBrowserSession.mockRejectedValueOnce(new Error('session store down'));

    await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, { cookie: touchCookie });

    expect(mockEmitSignup).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-new', method: 'github' }));
  });

  // The case the whole SameSite=Lax change exists to serve, and the one the first version of
  // this gate got wrong: a visitor who never touched the marketing site, landed on the app, and
  // accepted its own banner. Their decision lives in localStorage, which this handler cannot
  // read, so the banner publishes it to `b4m_consent` - and gating only on the marketing
  // cookie suppressed every one of these.
  it('sends touches for a visitor who consented on this origin, with no marketing cookie', async () => {
    await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, {
      cookie: `${touch}; b4m_consent=granted`,
    });

    expect(mockEmitSignup).toHaveBeenCalledWith({
      userId: 'u-new',
      touches: { lastTouch: { source: 'widgets', medium: 'landing' } },
      method: 'github',
    });
  });

  // The inverse, and why this origin outranks the shared cookie rather than merely supplementing
  // it: a decline here must not be overridden by a grant the visitor gave on the other host,
  // which is what checkout's own precedence does too.
  it('withholds touches when this origin was declined but the marketing cookie says granted', async () => {
    await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, {
      cookie: `${touch}; b4m_consent=denied; b4m-consent-decision=granted`,
    });

    expect(mockEmitSignup).toHaveBeenCalledWith({ userId: 'u-new', touches: {}, method: 'github' });
  });

  // The gate fails closed, so each of these is a separate way of NOT saying granted. Absent is
  // the one that matters most in practice: a visitor who has opened neither banner carries no
  // decision at all.
  it.each([
    ['denied', `${touch}; b4m-consent-decision=denied`],
    ['absent', touch],
    ['unrecognised', `${touch}; b4m-consent-decision=yes`],
  ])('sends no touches when consent is %s', async (_label, cookie) => {
    await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, { cookie });

    // The emitter is still CALLED, with no touches, so the consent gate is the only thing that
    // decided this and the signup path itself is unchanged. Nothing reaches Overwatch either
    // way: with no touches there is no source product, so this stream sends nothing at all for
    // a suppressed visitor. The account is recorded in Mongo by the REGISTER log above, which
    // is a different system.
    expect(mockEmitSignup).toHaveBeenCalledWith({ userId: 'u-new', touches: {}, method: 'github' });
  });
});
