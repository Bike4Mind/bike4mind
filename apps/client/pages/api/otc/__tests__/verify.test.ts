import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CreditHolderType } from '@bike4mind/common';
import { signupCreditsForEmail } from '@client/lib/entitlements/registry';

// Middleware is stripped so the handler body runs directly (same pattern as the
// email/verify suite). baseApi().use(...).use(...).post(fn) must chain and hand back
// the raw handler.
// The middleware passed to .use() is recorded so the limiter wiring can be asserted on its own.
const wiring = vi.hoisted(() => ({ uses: [] as any[] }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: (mw: any) => {
        wiring.uses.push(mw);
        return chain;
      },
      post: (fn: any) => fn,
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next?.(),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn(() => Promise.resolve()) }));
const mockEmitSignup = vi.fn().mockResolvedValue([]);
vi.mock('@server/analytics/signupEvents', () => ({
  emitSignupForSourceProducts: (...a: any[]) => mockEmitSignup(...a),
}));
const mockRecordSignupAcquisition = vi.fn().mockResolvedValue({ isSynthetic: false });
const mockEmitFunnelEvent = vi.fn().mockResolvedValue(true);
vi.mock('@server/analytics/funnel', () => ({
  recordSignupAcquisition: (...a: any[]) => mockRecordSignupAcquisition(...a),
  emitFunnelEvent: (...a: any[]) => mockEmitFunnelEvent(...a),
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn(() => Promise.resolve()) }));
vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' }, isE2EEnabled: () => false }));
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: { createAccessToken: () => ({ accessToken: 'a', refreshToken: 'r' }) },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: vi.fn(), getSettingsValue: vi.fn() }));

// The one-time code is already proven by the time we reach registration; stub the
// verify layer so the happy path lands on the new-user branch.
const mockJwtVerify = vi.fn();
vi.mock('jsonwebtoken', () => ({
  default: { verify: (...a: any[]) => mockJwtVerify(...a), sign: () => 'signed-token' },
}));

// DB-backed partner rules (issue #293). Default to "no rule" so the base cases fall
// through to the env registry; DB-precedence cases set a match.
const mockPartnerGrant = vi.fn();
vi.mock('@server/entitlements/partnerRules', () => ({
  partnerSignupGrantForEmail: (...a: any[]) => mockPartnerGrant(...a),
}));

const mockFindByEmail = vi.fn();
const mockValidateNonce = vi.fn();
const mockConsumeOtherCodes = vi.fn();
const mockTryIncrement = vi.fn(async (_key: string, _limit: number, _ttlMs: number) => ({
  success: true,
  count: 1,
  expiresAt: new Date(Date.now() + 60_000),
}));
const mockDecrement = vi.fn();
const mockTryAdd = vi.fn(async (_key: string, _amount: number, _limit: number, _ttlMs: number) => ({
  success: true,
  count: 0,
  expiresAt: new Date(Date.now() + 60_000),
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: (...a: any[]) => mockTryIncrement(...a),
    decrementCounter: (...a: any[]) => mockDecrement(...a),
    tryAddWithinLimitFixedWindow: (...a: [string, number, number, number]) => mockTryAdd(...a),
  },
  adminSettingsRepository: { findBySettingName: vi.fn() },
  registrationInviteRepository: {},
  subscriberRepository: {},
  creditTransactionRepository: {},
  userRepository: { findByEmail: (...a: any[]) => mockFindByEmail(...a), count: vi.fn(), update: vi.fn() },
  pendingOtcTokenRepository: {
    validateAndRotateNonce: (...a: any[]) => mockValidateNonce(...a),
    consumeOtherCodes: (...a: any[]) => mockConsumeOtherCodes(...a),
  },
  authSessionRepository: {},
}));

const mockVerifyPendingOTC = vi.fn();
const mockRegisterViaOTC = vi.fn();
const mockAddCredits = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: {
    verifyPendingOTC: (...a: any[]) => mockVerifyPendingOTC(...a),
    registerViaOTC: (...a: any[]) => mockRegisterViaOTC(...a),
  },
  creditService: { addCredits: (...a: any[]) => mockAddCredits(...a) },
  mfaService: { userHasMFAConfigured: () => false },
  authSessionService: {
    issueSession: vi.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r', sid: 'sid' }),
  },
}));

import { authSessionService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import handler from '@pages/api/otc/verify';
import { OTC_LIMITS, otcEmailKey } from '@server/utils/otcLimits';

// bike4mind.com is seeded as an internal-staff domain in vitest.setup.ts, so the real
// registry confers optihashi:pro -> its signup-credit total for this address.
const DOMAIN_EMAIL = 'newstaff@bike4mind.com';
const NON_DOMAIN_EMAIL = 'nobody@example.com';
// Pinned literal (not derived from the registry, which would make the assertions circular):
// the optihashi:pro grant pays 250,000. This path resolves the literal domain keys only (no
// implication expansion), so the implied questmaster:pro credit is not in play here - the
// implied-key de-dup is pinned in the registry test.
const EXPECTED_DOMAIN_CREDITS = 250_000;

function makeReqRes(email = DOMAIN_EMAIL) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).body = {
    email,
    code: '123456',
    username: 'newstaff',
    pendingToken: 'pending-token',
    acceptedPolicyVersion: 'v1',
    ageAttestation: true,
  };
  (req as any).ip = '127.0.0.1';
  (req as any).socket = { remoteAddress: '127.0.0.1' };
  (req as any).headers = { 'user-agent': 'test' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // jwt payload for this address - a correct, unexpired, single-use code.
  mockJwtVerify.mockReturnValue({
    email: email.toLowerCase().trim(),
    attempts: 0,
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: 'jti-1',
  });
  return { req, res };
}

const domainGrantCall = () =>
  mockAddCredits.mock.calls.find(([p]) => p.transactionId === 'domain-grant-credits:user-1');

// Runs every recorded middleware in order, as baseApi would before the route handler.
async function runMiddleware(req: any, res: any) {
  for (const mw of wiring.uses) {
    await new Promise<void>((resolve, reject) => {
      Promise.resolve(mw(req, res, (err?: unknown) => (err ? reject(err) : resolve()))).catch(reject);
    });
  }
}

describe('/api/otc/verify limiter wiring', () => {
  it('counts every attempt per IP but leaves the per-email budget to the handler', async () => {
    mockTryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    await runMiddleware(req, res);

    const { perIp } = OTC_LIMITS.verify;
    expect(mockTryIncrement).toHaveBeenCalledTimes(1);
    expect(mockTryIncrement).toHaveBeenCalledWith(
      expect.stringMatching(/^otc-limit:verify-ip:/),
      perIp.limit,
      perIp.windowMs
    );
  });
});

describe('/api/otc/verify per-email budget', () => {
  // makeReqRes requests come from the socket address 127.0.0.1.
  const budgetKeyFor = (email: string, ip = '127.0.0.1') =>
    `otc-limit:verify-email-ip:${otcEmailKey(`${email}|${ip}`)}`;
  const budgetKey = budgetKeyFor(NON_DOMAIN_EMAIL);

  beforeEach(() => {
    vi.clearAllMocks();
    mockTryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
    mockValidateNonce.mockResolvedValue('hash');
    mockVerifyPendingOTC.mockResolvedValue(false);
  });

  afterEach(() => {
    mockTryAdd.mockImplementation(async () => ({ success: true, count: 0, expiresAt: new Date(Date.now() + 60_000) }));
  });

  it('does not spend the budget on attempts without a live token for the address', async () => {
    for (const setup of [
      () =>
        mockJwtVerify.mockImplementation(() => {
          throw new Error('bad signature');
        }),
      () => mockValidateNonce.mockResolvedValue(null),
    ]) {
      const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
      setup();
      await expect(handler(req, res)).rejects.toThrow();
      mockJwtVerify.mockReset();
      mockValidateNonce.mockResolvedValue('hash');
    }
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    req.body.pendingToken = undefined;
    await expect(handler(req, res)).rejects.toThrow();

    // The unit is reserved up front and handed back once the nonce proves stale.
    expect(mockDecrement).toHaveBeenCalledTimes(mockTryIncrement.mock.calls.length);
  });

  it('spends the budget on a wrong guess against a live token', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    await handler(req, res);

    expect(res._getStatusCode()).toBe(422);
    const { perEmailPerIp } = OTC_LIMITS.verify;
    expect(mockTryIncrement).toHaveBeenCalledWith(budgetKey, perEmailPerIp.limit, perEmailPerIp.windowMs);
  });

  it('charges the exact token address, so alias tokens cannot drain the owner', async () => {
    const alias = 'nobody+x@example.com';
    const { req, res } = makeReqRes(alias);
    await handler(req, res);

    expect(res._getStatusCode()).toBe(422);
    const { perEmailPerIp } = OTC_LIMITS.verify;
    expect(mockTryIncrement).toHaveBeenCalledWith(budgetKeyFor(alias), perEmailPerIp.limit, perEmailPerIp.windowMs);
    expect(mockTryIncrement).not.toHaveBeenCalledWith(budgetKey, expect.anything(), expect.anything());
  });

  describe('across sources', () => {
    const ATTACKER_IP = '81.2.69.166';
    const OWNER_IP = '81.2.69.110';
    const counts = new Map<string, number>();
    const window = () => new Date(Date.now() + 60_000);

    beforeEach(() => {
      counts.clear();
      mockTryIncrement.mockImplementation(async (key: string, limit: number) => {
        const count = counts.get(key) ?? 0;
        if (count + 1 > limit) return { success: false, count, expiresAt: window() };
        counts.set(key, count + 1);
        return { success: true, count: count + 1, expiresAt: window() };
      });
      mockDecrement.mockImplementation(async (key: string) => {
        counts.set(key, (counts.get(key) ?? 0) - 1);
      });
      mockTryAdd.mockImplementation(async (key: string) => ({
        success: true,
        count: counts.get(key) ?? 0,
        expiresAt: window(),
      }));
    });

    const verifyFrom = async (ip: string) => {
      const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
      (req as any).headers['x-real-ip'] = ip;
      req.body.username = undefined;
      await handler(req, res);
      return res;
    };

    it('lets the owner verify from another source after an attacker spends its own budget', async () => {
      const { limit } = OTC_LIMITS.verify.perEmailPerIp;
      for (let i = 0; i < limit; i++) expect((await verifyFrom(ATTACKER_IP))._getStatusCode()).toBe(422);
      expect(counts.get(budgetKeyFor(NON_DOMAIN_EMAIL, ATTACKER_IP))).toBe(limit);

      const refused = await verifyFrom(ATTACKER_IP);
      expect(refused._getStatusCode()).toBe(429);
      expect(refused.getHeader('Retry-After')).toBeDefined();

      mockVerifyPendingOTC.mockResolvedValue(true);
      mockFindByEmail.mockResolvedValue(null);
      const owner = await verifyFrom(OWNER_IP);
      expect(owner._getStatusCode()).toBe(200);
    });

    it('still caps each source on its own', async () => {
      const { limit } = OTC_LIMITS.verify.perEmailPerIp;
      for (let i = 0; i < limit; i++) await verifyFrom(OWNER_IP);

      const refused = await verifyFrom(OWNER_IP);
      expect(refused._getStatusCode()).toBe(429);
      expect(refused.getHeader('Retry-After')).toBeDefined();
      expect(mockVerifyPendingOTC).toHaveBeenCalledTimes(limit);
    });

    it('cannot overshoot the limit under concurrent wrong guesses', async () => {
      const { limit } = OTC_LIMITS.verify.perEmailPerIp;
      const results = await Promise.all(Array.from({ length: limit + 3 }, () => verifyFrom(OWNER_IP)));
      const statuses = results.map(r => r._getStatusCode());
      expect(statuses.filter(c => c === 422)).toHaveLength(limit);
      expect(statuses.filter(c => c === 429)).toHaveLength(3);
      expect(mockVerifyPendingOTC).toHaveBeenCalledTimes(limit);
      expect(counts.get(budgetKeyFor(NON_DOMAIN_EMAIL, OWNER_IP))).toBe(limit);
    });

    it('refunds a correct code so it leaves the budget untouched', async () => {
      mockVerifyPendingOTC.mockResolvedValue(true);
      mockFindByEmail.mockResolvedValue(null);
      expect((await verifyFrom(OWNER_IP))._getStatusCode()).toBe(200);
      expect(counts.get(budgetKeyFor(NON_DOMAIN_EMAIL, OWNER_IP))).toBe(0);
    });
  });

  it('does not spend the budget on a correct code', async () => {
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null);
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    req.body.username = undefined;
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockDecrement).toHaveBeenCalledTimes(mockTryIncrement.mock.calls.length);
    expect(mockDecrement).toHaveBeenCalledWith(budgetKey);
  });

  it('refuses with 429 and Retry-After before evaluating a guess once the budget is spent', async () => {
    mockTryIncrement.mockResolvedValue({
      success: false,
      count: OTC_LIMITS.verify.perEmailPerIp.limit,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    await handler(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(res.getHeader('Retry-After')).toBeDefined();
    expect(mockValidateNonce).not.toHaveBeenCalled();
    expect(mockVerifyPendingOTC).not.toHaveBeenCalled();
  });
});

describe('/api/otc/verify — domain-grant signup credits (Register now flow)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
    mockValidateNonce.mockResolvedValue('hash');
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null); // new user -> registration branch
    mockRegisterViaOTC.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 1000 });
    mockAddCredits.mockResolvedValue({ currentCredits: 1000 + EXPECTED_DOMAIN_CREDITS });
    mockPartnerGrant.mockResolvedValue({ matched: false, entitlements: new Set(), signupCredits: 0 });
  });

  const firstTouch = `b4m-first-touch=${encodeURIComponent(JSON.stringify({ source: 'widgets' }))}`;

  it("credits the new account's signup to the product in its touch cookies, as an otc signup", async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    (req as any).headers.cookie = `${firstTouch}; b4m-consent-decision=granted`;

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockEmitSignup).toHaveBeenCalledWith({
      userId: 'user-1',
      touches: { firstTouch: { source: 'widgets' } },
      method: 'otc',
    });
  });

  it('persists the signup touches and reports email_verified and credits_granted for the new user', async () => {
    const acquisition = { firstTouch: { source: 'widgets' }, signupMethod: 'otc', capturedAt: new Date() };
    mockRecordSignupAcquisition.mockResolvedValueOnce({ acquisition, isSynthetic: false });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRecordSignupAcquisition).toHaveBeenCalledWith(
      expect.objectContaining({ req, user: expect.objectContaining({ id: 'user-1' }), method: 'otc' })
    );
    const user = { id: 'user-1', acquisition, isSynthetic: false };
    expect(mockEmitFunnelEvent).toHaveBeenCalledWith({ user, event: 'email_verified', metadata: { method: 'otc' } });
    expect(mockEmitFunnelEvent).toHaveBeenCalledWith({
      user,
      event: 'credits_granted',
      metadata: { amount: 1000, source: 'signup', method: 'otc' },
    });
  });

  it('keeps a synthetic account out of the signup conversion', async () => {
    mockRecordSignupAcquisition.mockResolvedValueOnce({ isSynthetic: true });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockEmitSignup).not.toHaveBeenCalled();
  });

  it('sends the signup conversion for a normal account', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(mockEmitSignup).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', method: 'otc' }));
  });

  it('reports no credits_granted when the signup seeded none', async () => {
    mockRegisterViaOTC.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 0 });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(mockEmitFunnelEvent.mock.calls.map(([c]) => c.event)).toEqual(['email_verified']);
  });

  // The account exists once registerViaOTC returns and a retry is a login, not a signup, so an
  // emit placed after the session mint would be lost for good when the mint fails.
  it('still sends the signup when minting the session fails', async () => {
    vi.mocked(authSessionService.issueSession).mockRejectedValueOnce(new Error('session store down'));
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    (req as any).headers.cookie = `${firstTouch}; b4m-consent-decision=granted`;

    await Promise.resolve(handler(req, res)).catch(() => {});

    expect(mockEmitSignup).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', method: 'otc' }));
  });

  // The REGISTER log and the emit are separate statements; folding the emit into the log's
  // error handling would drop a signup whenever the log write fails.
  it('still sends the signup when the REGISTER log fails', async () => {
    vi.mocked(logEvent).mockRejectedValueOnce(new Error('log store down'));
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    (req as any).headers.cookie = `${firstTouch}; b4m-consent-decision=granted`;

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockEmitSignup).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', method: 'otc' }));
  });

  // This cookie is the reason the gate has to exist. `b4m-first-touch` lives on the parent
  // domain, `clearAttributionCookies` deliberately leaves it alone on a decline, and
  // readAcquisitionCookies PREFERS it over the app's own first-touch cookie - so a visitor who
  // declined still arrives here carrying a perfectly readable touch. Without the gate they would
  // be attributed anyway.
  it('withholds a surviving marketing touch when consent was declined', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    (req as any).headers.cookie = `${firstTouch}; b4m-consent-decision=denied`;

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockEmitSignup).toHaveBeenCalledWith({ userId: 'user-1', touches: {}, method: 'otc' });
  });

  // The case SameSite=Lax exists for, and the one the first version of this gate suppressed: a
  // visitor who never saw the marketing site, landed here, and accepted this app's own banner.
  // Their decision is in localStorage, which this handler cannot read, so the banner publishes
  // it to `b4m_consent`.
  it('credits a visitor who consented on this origin, with no marketing cookie', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    (req as any).headers.cookie = `${firstTouch}; b4m_consent=granted`;

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockEmitSignup).toHaveBeenCalledWith({
      userId: 'user-1',
      touches: { firstTouch: { source: 'widgets' } },
      method: 'otc',
    });
  });

  // This origin outranks the shared cookie rather than supplementing it, so a decline here is
  // not overridden by a grant given on the other host - matching checkout's own precedence.
  it('withholds touches when this origin was declined but the marketing cookie says granted', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    (req as any).headers.cookie = `${firstTouch}; b4m_consent=denied; b4m-consent-decision=granted`;

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockEmitSignup).toHaveBeenCalledWith({ userId: 'user-1', touches: {}, method: 'otc' });
  });

  // The guard is structural, not conditional: the emit sits after the existingUser branch has
  // already returned. Nothing asserted that until now, so moving the emit above that return - or
  // adding a second call site on the login path - left this whole suite green while every
  // returning login re-emitted a `signup`. OAuth has the counterpart assertion in
  // [strategy]/__tests__/callback.test.ts ("sends nothing for a returning user").
  it('sends nothing when the code proves a returning user rather than a new one', async () => {
    mockFindByEmail.mockResolvedValue({
      id: 'u-existing',
      isSystem: false,
      isBanned: false,
      emailVerified: true,
      tokenVersion: 0,
      toJSON: () => ({ id: 'u-existing', username: 'bob' }),
    });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    (req as any).headers.cookie = `${firstTouch}; b4m_consent=granted`;

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRegisterViaOTC).not.toHaveBeenCalled();
    expect(mockEmitSignup).not.toHaveBeenCalled();
  });

  it('is a sanity check that the fixture domain actually confers the product credit sum', () => {
    // Guards the suite: if bike4mind.com ever stops conferring the product, the credit
    // assertions below would silently pass on 0.
    expect(signupCreditsForEmail(DOMAIN_EMAIL, true)).toBe(EXPECTED_DOMAIN_CREDITS);
  });

  it('grants domain-grant signup credits to a new OTC registration on a partner domain', async () => {
    const { req, res } = makeReqRes(DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const call = domainGrantCall();
    expect(call).toBeTruthy();
    expect(call![0]).toEqual(
      expect.objectContaining({
        ownerId: 'user-1',
        ownerType: CreditHolderType.User,
        credits: 250_000,
        type: 'generic_add',
        transactionId: 'domain-grant-credits:user-1',
      })
    );
    // The returned user reflects the grant on top of the flat defaultFreeCredits.
    expect(res._getJSONData().user.currentCredits).toBe(1000 + EXPECTED_DOMAIN_CREDITS);
  });

  it('does NOT grant domain credits to a new OTC registration on a non-partner domain', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('uses the SAME stable idempotent transactionId as email/verify so both paths cannot double-grant', async () => {
    const first = makeReqRes(DOMAIN_EMAIL);
    await handler(first.req, first.res);
    const second = makeReqRes(DOMAIN_EMAIL);
    await handler(second.req, second.res);

    const ids = mockAddCredits.mock.calls.map(([p]) => p.transactionId);
    // Both invocations key on `domain-grant-credits:${userId}` - the addCredits
    // transactionId gate turns any duplicate (re-run, or the email-verify path) into a no-op.
    expect(ids).toEqual(['domain-grant-credits:user-1', 'domain-grant-credits:user-1']);
  });

  it('swallows a domain-grant failure and still returns registration success', async () => {
    mockAddCredits.mockRejectedValueOnce(new Error('boom'));
    const { req, res } = makeReqRes(DOMAIN_EMAIL);

    await handler(req, res);

    // Registration is complete and the token is issued; the grant failure must not 500.
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().user.id).toBe('user-1');
    expect((req as any).logger.error).toHaveBeenCalled();
  });

  it('still logs the user in when consumeOtherCodes throws, and logs the error', async () => {
    mockConsumeOtherCodes.mockRejectedValueOnce(new Error('db down'));
    mockFindByEmail.mockResolvedValue(null);
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect((req as any).logger.error).toHaveBeenCalledWith('OTC login consumeOtherCodes failed', expect.any(Error));
  });

  it('grants the DB rule signupCredits (per-partner amount) over the env amount', async () => {
    // A domain the env registry does NOT confer, so env would grant 0 - proves the DB
    // rule is what fires.
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 150_000,
    });
    const { req, res } = makeReqRes('person@newpartner.com');

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(domainGrantCall()?.[0]).toEqual(
      expect.objectContaining({ credits: 150_000, transactionId: 'domain-grant-credits:user-1' })
    );
  });

  it('honors a DB rule that grants access with 0 bonus credits (no env fallback)', async () => {
    // Even for an env-domain email, a matched rule with 0 credits must NOT fall back to
    // the env amount - `matched` distinguishes "0 on purpose" from "no rule".
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 0,
    });
    const { req, res } = makeReqRes(DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(domainGrantCall()).toBeFalsy();
  });
});
