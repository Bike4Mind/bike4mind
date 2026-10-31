import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Middleware: collapse the baseApi chain so `.get(fn)` yields the raw handler,
// mirroring apps/client/pages/api/auth/okta/__tests__/callback.test.ts.
const mockChain = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { use: () => Chain; get: (fn: unknown) => unknown };
  const chain: Chain = {
    use: () => chain,
    get: fn => {
      mockChain.order.push('get');
      return fn;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => {
    mockChain.order.push('checkBlockedIP');
    return (_req: unknown, _res: unknown, next?: () => void) => next?.();
  },
}));
vi.mock('@server/middlewares/oauthIpRateLimit', () => ({
  oauthIpRateLimit: (bucket: string) => {
    mockChain.order.push(`oauthIpRateLimit:${bucket}`);
    return (_req: unknown, _res: unknown, next?: () => void) => next?.();
  },
}));
const { rateLimitOptions } = vi.hoisted(() => ({ rateLimitOptions: [] as unknown[] }));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (opts: unknown) => {
    rateLimitOptions.push(opts);
    return (_req: any, _res: any, next: any) => next?.();
  },
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
vi.mock('@bike4mind/server-utils/auth/jwtStateStore', () => ({ verifyStateToken: vi.fn() }));

const mockResolveSecondFactor = vi.fn();
const mockLogSignInSuccess = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/auth/signInSecondFactor', () => ({
  resolveSecondFactor: (...a: any[]) => mockResolveSecondFactor(...a),
  logSignInSuccess: (...a: any[]) => mockLogSignInSuccess(...a),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));

const mockEmitSignup = vi.fn().mockResolvedValue([]);
vi.mock('@server/analytics/signupEvents', () => ({
  emitSignupForSourceProducts: (...a: any[]) => mockEmitSignup(...a),
}));
const mockRecordSignupAcquisition = vi.fn().mockResolvedValue({ isSynthetic: false });
const mockEmitSignupFunnelEvents = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/analytics/funnel', () => ({
  recordSignupAcquisition: (...a: any[]) => mockRecordSignupAcquisition(...a),
  emitSignupFunnelEvents: (...a: any[]) => mockEmitSignupFunnelEvents(...a),
}));

const mockRecordSignupNetwork = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/auth/networkMeta', () => ({
  recordSignupNetwork: (...a: any[]) => mockRecordSignupNetwork(...a),
}));

const mockRefreshSignupRiskScore = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/auth/riskEvidence', () => ({ requestRiskEvidenceRefresh: vi.fn(async () => 'queued') }));
vi.mock('@server/auth/signupRiskScore', () => ({
  refreshSignupRiskScore: (...a: unknown[]) => mockRefreshSignupRiskScore(...a),
}));

const mockIssueBrowserSession = vi.fn().mockResolvedValue({ accessToken: 'jwt-access', sid: 'sid' });
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: (...a: any[]) => mockIssueBrowserSession(...a),
}));

const mockStampSourceTag = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/auth/oauthSourceTag', () => ({
  stampOAuthSourceTag: (...a: unknown[]) => mockStampSourceTag(...a),
}));

// Import after mocks are registered.
import { logEvent } from '@server/utils/analyticsLog';
import { verifyStateToken, type VerifyResult, type BaseStatePayload } from '@bike4mind/server-utils/auth/jwtStateStore';
import { logAuthAudit } from '@server/utils/authAudit';

const stateNaming = (clientId: string): VerifyResult<BaseStatePayload & { clientId: string }> => ({
  valid: true,
  payload: { handle: 'h', createdAt: 0, aud: 'google-oauth-state', iss: 'test', clientId },
});
import handler from '@pages/api/auth/[strategy]/callback';

function makeReqRes(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  const { req, res } = createMocks({
    method: 'GET',
    query: { strategy: 'github', state: 'state-token', ...query },
    headers: { host: 'localhost:3000', 'user-agent': 'vitest', ...headers },
    url: '/api/auth/github/callback',
  });
  return { req: req as any, res: res as any };
}

/** Drive the handler as if passport's verify callback resolved with (err, user, info). */
async function runCallback(
  err: unknown,
  user: unknown,
  info: unknown,
  headers?: Record<string, string>,
  query?: Record<string, string>
) {
  // The handler does not await passport's callback, so hold on to the promise it returns and wait
  // for that: a fixed tick races any await added above the code under test.
  let passportCallback: Promise<unknown> | undefined;
  mockAuthenticate.mockImplementation((_strategy: string, _opts: any, cb: any) => () => {
    passportCallback = cb(err, user, info);
  });
  const { req, res } = makeReqRes(headers, query);
  await handler(req, res, vi.fn());
  await passportCallback;
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSecondFactor.mockResolvedValue({ kind: 'satisfied', trustedDevice: null });
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
    expect(redirectUrl).toBe('/login?error=callback_error');
    expect(redirectUrl).not.toContain('victim');
    expect(redirectUrl).not.toContain('E11000');
  });

  it('maps state_expired to a distinct canonical reason with a friendly retry redirect', async () => {
    const res = await runCallback(null, undefined, {
      code: 'state_expired',
      message: 'Authorization request expired. Please try again.',
    });

    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state_expired' }));
    expect(res._getRedirectUrl()).toBe('/login?error=invalid_state');
  });

  it('maps state_missing and state_invalid to their own distinct canonical reasons', async () => {
    const missingRes = await runCallback(null, undefined, {
      code: 'state_missing',
      message: 'Missing state parameter',
    });
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state_missing' }));
    expect(missingRes._getRedirectUrl()).toBe('/login?error=callback_error');

    vi.clearAllMocks();

    const invalidRes = await runCallback(null, undefined, {
      code: 'state_invalid',
      message: 'Invalid authorization state.',
    });
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state_invalid' }));
    expect(invalidRes._getRedirectUrl()).toBe('/login?error=callback_error');
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
    expect(withNoInfo._getRedirectUrl()).toBe('/login?error=callback_error');
    void withUnknownCode;
  });

  it('maps forbidden_system_user to its own distinct canonical reason', async () => {
    const res = await runCallback(null, undefined, {
      code: 'forbidden_system_user',
      message: 'Cannot authenticate as a system account',
    });

    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'forbidden_system_user' }));
    expect(res._getRedirectUrl()).toBe('/login?error=callback_error');
  });
});

describe('[strategy]/callback - !user branch log level', () => {
  it.each([
    'registration_closed',
    'state_expired',
    'state_invalid',
    'state_missing',
    'duplicate_account',
    'forbidden_system_user',
  ])('logs the expected %s outcome at warn, below the level the alert channel pages on', async code => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runCallback(null, undefined, { code });

    expect(warnSpy).toHaveBeenCalledWith('Passport Authenticate User Not Found Info:', { code });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('logs a cancelled consent (?error=access_denied) at warn with its own reason', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // What passport-oauth2 passes to fail() when the provider redirects back with access_denied.
    const info = { message: 'The user has denied your application access.' };

    const res = await runCallback(null, undefined, info, undefined, { error: 'access_denied' });

    expect(warnSpy).toHaveBeenCalledWith('Passport Authenticate User Not Found Info:', info);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'access_denied' }));
    expect(res._getRedirectUrl()).toBe('/login?error=callback_error');
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('keeps an unrecognized failure at error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runCallback(null, undefined, { message: 'Failed to obtain access token' });

    expect(errorSpy).toHaveBeenCalledWith('Passport Authenticate User Not Found Info:', {
      message: 'Failed to obtain access token',
    });
    expect(warnSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('[strategy]/callback - guards', () => {
  it('rate limits the callback at 10/min per client IP in the oauth-callback bucket', () => {
    expect(rateLimitOptions).toEqual([{ limit: 10, windowMs: 60 * 1000, bucket: 'oauth-callback' }]);
  });
});

describe('[strategy]/callback - err branch log level', () => {
  /** Shaped like passport-oauth2's TokenError, which carries the provider's OAuth error code. */
  function tokenError(code: string) {
    return Object.assign(new Error('Bad Request'), { name: 'TokenError', code });
  }

  it('logs a replayed or expired authorization code (invalid_grant) at warn', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = tokenError('invalid_grant');

    const res = await runCallback(err, undefined, undefined);

    expect(warnSpy).toHaveBeenCalledWith('Passport Authenticate Error:', undefined, err);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(res._getRedirectUrl()).toBe('/login?error=Authentication%20failed');
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it.each([
    ['another TokenError code', tokenError('invalid_client')],
    ['a non-token error', new Error('boom')],
  ])('keeps %s at error', async (_label, err) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runCallback(err, undefined, undefined);

    expect(errorSpy).toHaveBeenCalledWith('Passport Authenticate Error:', undefined, err);
    expect(warnSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
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

    expect(mockIssueBrowserSession).toHaveBeenCalled();
    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
    expect(res._getRedirectUrl()).not.toContain('firstSignupSession');
  });
});

describe('[strategy]/callback - guards and refusal metric line', () => {
  it('registers the block check and the per-IP limit ahead of the get handler', () => {
    expect(mockChain.order).toEqual(['checkBlockedIP', 'oauthIpRateLimit:oauth-callback', 'get']);
  });

  it.each([
    ['registration_closed', 1],
    ['state_expired', 0],
    ['internal', 0],
  ])('logs oauth-signup-refused for %s: %i time(s)', async (code, count) => {
    const info = vi.fn();
    mockAuthenticate.mockImplementation(
      (_s: string, _o: unknown, cb: (...args: unknown[]) => Promise<unknown>) => () => {
        pending = cb(null, undefined, { code });
      }
    );
    let pending: Promise<unknown> | undefined;
    const { req, res } = makeReqRes();
    req.logger = { info };
    await handler(req, res, vi.fn());
    await pending;
    expect(info.mock.calls.filter(c => c[0] === 'oauth-signup-refused')).toHaveLength(count);
  });
});

describe('[strategy]/callback - invite gate', () => {
  it('surfaces registration_closed as a login error code', async () => {
    const res = await runCallback(null, undefined, { code: 'registration_closed' });

    expect(mockAuthFailCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'registration_closed' }));
    expect(res._getRedirectUrl()).toBe('/login?error=registration_closed');
  });
});

describe('[strategy]/callback - signup credited to the source product', () => {
  const touch = `b4m_last_touch=${encodeURIComponent(JSON.stringify({ source: 'widgets', medium: 'landing' }))}`;
  // Attribution is gated server-side on a consent decision, so a touch cookie alone is not
  // enough to emit - see readConsentedAcquisitionTouches.
  const touchCookie = `${touch}; b4m-consent-decision=granted`;

  it.each(['google', 'github'])('emits one complete signup funnel for %s', async strategy => {
    const { req, res } = makeReqRes();
    req.query.strategy = strategy;
    let passportCallback: Promise<unknown> | undefined;
    mockAuthenticate.mockImplementation((_strategy: string, _opts: any, cb: any) => () => {
      passportCallback = cb(null, {
        id: 'u-new',
        isBanned: false,
        isNewUser: true,
        emailVerified: true,
        signupCreditsGranted: 100,
      });
    });

    await handler(req, res, vi.fn());
    await passportCallback;

    expect(mockEmitSignupFunnelEvents).toHaveBeenCalledTimes(1);
    expect(mockEmitSignupFunnelEvents).toHaveBeenCalledWith(
      expect.objectContaining({ method: strategy, emailVerified: true, creditsGranted: 100 })
    );
  });

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
    expect(res._getRedirectUrl()).toContain('firstSignupSession=1');
  });

  it("ties a new account's signup funnel to the visit it came from", async () => {
    const visitId = 'd'.repeat(32);
    await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, {
      cookie: `${touchCookie}; b4m_vid=${visitId}`,
    });

    expect(mockEmitSignupFunnelEvents).toHaveBeenCalledWith(expect.objectContaining({ visitId }));
  });

  it("persists a new account's acquisition with the provider as the signup method", async () => {
    await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, { cookie: touchCookie });

    expect(mockRecordSignupAcquisition).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'u-new' }), method: 'github' })
    );
  });

  it("stamps a new account's signup network with the provider as the method", async () => {
    await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, { cookie: touchCookie });

    expect(mockRecordSignupNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-new', method: 'github' })
    );
  });

  it('rescores a new account only after its signup network is stamped', async () => {
    await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, { cookie: touchCookie });

    // The test request carries no logger, so only the user id is asserted.
    expect(mockRefreshSignupRiskScore.mock.calls.map(([userId]) => userId)).toEqual(['u-new']);
    expect(mockRecordSignupNetwork.mock.invocationCallOrder[0]).toBeLessThan(
      mockRefreshSignupRiskScore.mock.invocationCallOrder[0]
    );
  });

  it('keeps a synthetic new account out of the signup emit and the ad conversion fragment', async () => {
    mockRecordSignupAcquisition.mockResolvedValueOnce({ isSynthetic: true });
    const res = await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined, {
      cookie: touchCookie,
    });

    expect(mockEmitSignup).not.toHaveBeenCalled();
    expect(res._getRedirectUrl()).not.toMatch(/isNewUser=1/);
    expect(res._getRedirectUrl()).toContain('firstSignupSession=1');
  });

  it('sends nothing for a returning user', async () => {
    await runCallback(null, { id: 'u-old', isBanned: false }, undefined, { cookie: touchCookie });

    expect(mockIssueBrowserSession).toHaveBeenCalled();
    expect(mockEmitSignup).not.toHaveBeenCalled();
    expect(mockRecordSignupAcquisition).not.toHaveBeenCalled();
    expect(mockRecordSignupNetwork).not.toHaveBeenCalled();
    expect(mockRefreshSignupRiskScore).not.toHaveBeenCalled();
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
    expect(res._getRedirectUrl()).toContain('firstSignupSession=1');
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

describe('[strategy]/callback - OAuth client source tag', () => {
  it('stamps a new account with the clientId from the verified state token', async () => {
    vi.mocked(verifyStateToken).mockReturnValueOnce(stateNaming('b4m_sat_0123abcd'));
    await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined);
    expect(mockStampSourceTag).toHaveBeenCalledWith('u-new', 'b4m_sat_0123abcd');
  });

  it('never stamps a returning user, even when the state names a client', async () => {
    vi.mocked(verifyStateToken).mockReturnValueOnce(stateNaming('b4m_sat_0123abcd'));
    await runCallback(null, { id: 'u-old', isBanned: false }, undefined);
    expect(mockStampSourceTag).not.toHaveBeenCalled();
  });

  it('passes no clientId when the state token does not verify', async () => {
    vi.mocked(verifyStateToken).mockReturnValueOnce({ valid: false, reason: 'invalid', message: 'bad' });
    const res = await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined);
    expect(mockStampSourceTag).toHaveBeenCalledWith('u-new', undefined);
    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success/);
  });
});

describe('[strategy]/callback - second factor gate', () => {
  it('hands an enrolled user to the MFA challenge without minting a session or logging a login', async () => {
    mockResolveSecondFactor.mockResolvedValue({ kind: 'challenge', mfaToken: 'pending-tok', passkeyAvailable: true });

    const res = await runCallback(null, { id: 'u-mfa', isBanned: false }, undefined);

    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success/);
    expect(res._getRedirectUrl()).toContain('#mfaToken=pending-tok&userId=u-mfa&mfa=verify&passkey=1');
    expect(res._getRedirectUrl()).not.toContain('#token=');
    expect(mockIssueBrowserSession).not.toHaveBeenCalled();
    expect(mockLogSignInSuccess).not.toHaveBeenCalled();
    expect(res._getRedirectUrl()).not.toContain('firstSignupSession');
  });

  it('keeps the requested redirectTo ahead of the MFA handoff fragment', async () => {
    vi.mocked(verifyStateToken).mockReturnValueOnce({
      valid: true,
      payload: {
        handle: 'h',
        createdAt: 0,
        aud: 'github-oauth-state',
        iss: 'test',
        redirectTo: '/projects/p1?tab=files',
      },
    });
    mockResolveSecondFactor.mockResolvedValue({ kind: 'challenge', mfaToken: 'pending-tok', passkeyAvailable: false });

    const res = await runCallback(null, { id: 'u-mfa', isBanned: false }, undefined);

    const location = res._getRedirectUrl();
    const expectedQuery = `/auth/success?redirectTo=${encodeURIComponent('/projects/p1?tab=files')}`;
    expect(location.startsWith(expectedQuery)).toBe(true);
    expect(location.indexOf(expectedQuery)).toBeLessThan(location.indexOf('#mfaToken='));
  });

  it('tells the second-factor step where the sign-in started so its completion can be audited', async () => {
    mockResolveSecondFactor.mockResolvedValue({ kind: 'challenge', mfaToken: 'pending-tok', passkeyAvailable: false });

    await runCallback(null, { id: 'u-mfa', isBanned: false }, undefined);

    expect(mockResolveSecondFactor).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      origin: { strategy: 'github', createdVia: 'oauth' },
    });
  });

  it('omits the passkey flag when the challenged user has no passkey', async () => {
    mockResolveSecondFactor.mockResolvedValue({ kind: 'challenge', mfaToken: 'pending-tok', passkeyAvailable: false });

    const res = await runCallback(null, { id: 'u-mfa', isBanned: false }, undefined);

    expect(res._getRedirectUrl()).toContain('&mfa=verify');
    expect(res._getRedirectUrl()).not.toContain('passkey=1');
  });

  it('sends a user who owes enrollment to MFA setup and still carries the new-account signup fragment', async () => {
    mockResolveSecondFactor.mockResolvedValue({ kind: 'enroll', mfaToken: 'pending-tok' });

    const res = await runCallback(null, { id: 'u-new', isBanned: false, isNewUser: true }, undefined);

    const redirectUrl = res._getRedirectUrl();
    expect(redirectUrl).toContain('#mfaToken=pending-tok&userId=u-new&mfa=setup');
    expect(redirectUrl).toContain('isNewUser=1&signupMethod=github');
    expect(redirectUrl).toContain('firstSignupSession=1');
    expect(mockIssueBrowserSession).not.toHaveBeenCalled();
    expect(mockLogSignInSuccess).not.toHaveBeenCalled();
  });

  it('records a new provider binding even when the second factor is still owed', async () => {
    mockResolveSecondFactor.mockResolvedValue({ kind: 'challenge', mfaToken: 'pending-tok', passkeyAvailable: false });

    await runCallback(null, { id: 'u-link', isBanned: false, isNewOAuthLink: true }, undefined);

    expect(logAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'u-link', event: 'oauth_link', strategy: 'github' })
    );
  });

  it('mints the session and logs the sign-in with the trusted device that satisfied the factor', async () => {
    const trustedDevice = { id: 'td-1', label: 'Laptop' };
    mockResolveSecondFactor.mockResolvedValue({ kind: 'satisfied', trustedDevice });

    const res = await runCallback(null, { id: 'u-ok', isBanned: false }, undefined);

    expect(mockIssueBrowserSession).toHaveBeenCalled();
    expect(mockLogSignInSuccess).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u-ok',
      strategy: 'github',
      trustedDevice,
    });
    expect(res._getRedirectUrl()).toMatch(/^\/auth\/success#token=/);
  });
});
