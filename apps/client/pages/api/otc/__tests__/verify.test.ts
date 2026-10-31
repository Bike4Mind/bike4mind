import { signupProtection } from '@server/auth/signupProtection';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('@server/auth/riskEvidence', () => ({ requestRiskEvidenceRefresh: vi.fn(async () => 'queued') }));
import { createMocks } from 'node-mocks-http';
import {
  BadRequestError,
  CreditHolderType,
  PENDING_FREE_CREDITS_TAG,
  RESERVED_USERNAME_MESSAGE,
  UnprocessableEntityError,
  TooManyRequestsError,
} from '@bike4mind/common';
import { signupCreditsForEmail } from '@bike4mind/server-utils/lib/entitlements/registry';
import { secretUserFields, expectSelfUserStripped } from '@server/auth/__tests__/sessionUserSecrets';

const { refreshSignupRiskScore } = vi.hoisted(() => ({ refreshSignupRiskScore: vi.fn(async () => undefined) }));
vi.mock('@server/auth/signupRiskScore', () => ({ refreshSignupRiskScore }));

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
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn(() => Promise.resolve()) }));
const mockEmitSignup = vi.fn().mockResolvedValue([]);
vi.mock('@server/analytics/signupEvents', () => ({
  emitSignupForSourceProducts: (...a: any[]) => mockEmitSignup(...a),
}));
const mockRecordSignupAcquisition = vi.fn().mockResolvedValue({ isSynthetic: false });
const mockEmitFunnelEvent = vi.fn().mockResolvedValue(true);
const mockEmitVerifiedFunnel = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/analytics/funnel', () => ({
  recordSignupAcquisition: (...a: any[]) => mockRecordSignupAcquisition(...a),
  emitFunnelEvent: (...a: any[]) => mockEmitFunnelEvent(...a),
  emitEmailVerifiedFunnelEvents: (...a: any[]) => mockEmitVerifiedFunnel(...a),
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn(() => Promise.resolve()) }));
const mockRecordSignupNetwork = vi.fn().mockResolvedValue(undefined);
const mockRecordLoginEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/auth/networkMeta', () => ({
  recordSignupNetwork: (...a: any[]) => mockRecordSignupNetwork(...a),
  recordLoginEvent: (...a: any[]) => mockRecordLoginEvent(...a),
  readNetworkMeta: () => ({
    ip: '203.0.113.5',
    userAgent: null,
    asn: 64500,
    asnOrg: null,
    country: null,
    isDatacenter: false,
  }),
}));
const mockAssertSignupNetworkWithinLimits = vi.fn().mockResolvedValue(undefined);
const mockSignupRiskCollector = vi.fn();
vi.mock('@server/auth/signupNetworkLimits', () => ({
  assertSignupNetworkWithinLimits: (...a: any[]) => mockAssertSignupNetworkWithinLimits(...a),
  createSignupRiskCollector: () => mockSignupRiskCollector,
}));
vi.mock('@bike4mind/server-utils/auth/signupGrantRisk', () => ({
  createSignupGrantRiskCollector: () => mockSignupRiskCollector,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret' },
  isE2EEnabled: () => false,
}));
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: { createAccessToken: () => ({ accessToken: 'a', refreshToken: 'r' }) },
}));
// Pulled in transitively by signupDomainGrant; the partner mock never matches a rule with a subscription.
vi.mock('@server/subscriptions/grantIndividualAdminSubscription', () => ({
  grantIndividualAdminSubscription: vi.fn(),
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: vi.fn(), getSettingsValue: vi.fn() }));
const mockWithTransaction = vi.fn(async (callback: () => Promise<unknown>) => callback());
vi.mock('@bike4mind/db-core', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/db-core')>()),
  withTransaction: (callback: () => Promise<unknown>) => mockWithTransaction(callback),
}));

// The one-time code is already proven by the time we reach registration; stub the
// verify layer so the happy path lands on the new-user branch.
const mockJwtVerify = vi.fn();
const mockJwtSign = vi.hoisted(() => vi.fn((..._a: unknown[]) => 'signed-token'));
const mockSetThrottleTier = vi.fn();
const mockRecordAdminActionForActor = vi.fn();
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionForActor: (...a: unknown[]) => mockRecordAdminActionForActor(...a),
  systemAuditActor: (name: string) => ({ kind: 'system', scope: 'platform', name, wasAdmin: false }),
}));
vi.mock('jsonwebtoken', () => ({
  default: { verify: (...a: any[]) => mockJwtVerify(...a), sign: (...a: unknown[]) => mockJwtSign(...a) },
}));

// DB-backed partner rules (issue #293). Default to "no rule" so the base cases fall
// through to the env registry; DB-precedence cases set a match.
const mockPartnerGrant = vi.fn();
vi.mock('@server/entitlements/partnerRules', () => ({
  partnerSignupGrantForEmail: (...a: any[]) => mockPartnerGrant(...a),
}));
// Identity redactor: the response schema alone has to drop secrets from the login/registration bodies.
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  redactUserSecretsForSelf: (user: unknown) => user,
}));
vi.mock('@server/entitlements/invalidate', () => ({ pushEntitlementInvalidation: vi.fn() }));

const mockFindByEmail = vi.fn();
const mockFindSetting = vi.fn();
const mockClaimOnce = vi.fn();
const mockReleaseClaim = vi.fn();
const mockValidateNonce = vi.fn();
const mockConsumeOtherCodes = vi.fn();
const mockUserUpdate = vi.fn();
const mockClearPending = vi.fn();
const mockAddTagsToUser = vi.fn();
const mockReleasePending = vi.fn();
const mockDomainEstablished = vi.fn(async (_domain: string, _verifiedBefore: Date) => false);
// Default: this inbox has not claimed its free-credit grant anywhere else, so the domain grant pays.
const mockClaimFreeCreditGrant = vi.fn(async (_userId: string) => true);
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
    findByKey: async () => null,
    createOrUpdate: async () => undefined,
  },
  adminSettingsRepository: {
    findBySettingName: (...args: unknown[]) => mockFindSetting(...args),
    claimOnce: (...args: unknown[]) => mockClaimOnce(...args),
    releaseClaim: (...args: unknown[]) => mockReleaseClaim(...args),
  },
  organizationRepository: {},
  registrationInviteRepository: {},
  subscriberRepository: {},
  creditTransactionRepository: {},
  creditLotRepository: {},
  userRepository: {
    findByEmail: (...a: unknown[]) => mockFindByEmail(...a),
    count: vi.fn(),
    update: (...a: unknown[]) => mockUserUpdate(...a),
    clearPendingFreeCreditGrant: (...a: unknown[]) => mockClearPending(...a),
    addTagsToUser: (...a: unknown[]) => mockAddTagsToUser(...a),
    existsVerifiedUserOnEmailDomain: (...a: unknown[]) => mockDomainEstablished(...a),
    // The domain grant claims the one-grant-per-inbox entitlement before crediting; these tests
    // are about the handler, so the inbox is always free here.
    claimFreeCreditGrant: (...a: unknown[]) => mockClaimFreeCreditGrant(...a),
  },
  pendingOtcTokenRepository: {
    validateAndRotateNonce: (...a: any[]) => mockValidateNonce(...a),
    consumeOtherCodes: (...a: any[]) => mockConsumeOtherCodes(...a),
  },
  authSessionRepository: {},
  oauthClientRepository: { findByClientId: vi.fn() },
}));

const mockVerifyPendingOTC = vi.fn();
const mockRegisterViaOTC = vi.fn();
const mockAddCredits = vi.fn();
const mockApplyPartnerRuleMembership = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: {
    verifyPendingOTC: (...a: any[]) => mockVerifyPendingOTC(...a),
    registerViaOTC: (...a: any[]) => mockRegisterViaOTC(...a),
    setThrottleTier: (...a: any[]) => mockSetThrottleTier(...a),
    releasePendingFreeCredits: (...a: unknown[]) => mockReleasePending(...a),
    refundBudgetOnFailure: <T>(fn: () => Promise<T>) => fn(),
  },
  creditService: { addCredits: (...a: any[]) => mockAddCredits(...a) },
  organizationService: { applyPartnerRuleMembership: (...a: unknown[]) => mockApplyPartnerRuleMembership(...a) },
  mfaService: { userHasMFAConfigured: () => false },
  authSessionService: {
    issueSession: vi.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r', sid: 'sid' }),
  },
}));

import { oauthClientRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import handler from '@pages/api/otc/verify';
import { OTC_LIMITS, otcEmailKey } from '@server/utils/otcLimits';

// In-memory stand-in for the unique settingName upsert: the first claim per name wins.
const claims = new Map<string, string>();
beforeEach(() => {
  mockRecordSignupNetwork.mockClear();
  mockRecordLoginEvent.mockClear();
  claims.clear();
  mockClearPending.mockResolvedValue({ tags: ['Customer'] });
  mockClaimOnce.mockImplementation(async (name: string, claimId: string) => {
    await Promise.resolve();
    if (claims.has(name)) return false;
    claims.set(name, claimId);
    return true;
  });
  mockReleaseClaim.mockImplementation(async (name: string, claimId: string) => {
    if (claims.get(name) !== claimId) return false;
    claims.delete(name);
    return true;
  });
  mockPartnerGrant.mockResolvedValue({ matched: false, entitlements: new Set(), signupCredits: 0, tags: [] });
  mockFindSetting.mockResolvedValue(null);
});

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
    mockValidateNonce.mockResolvedValue({ otcHash: 'hash', riskSignals: [] });
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
      mockValidateNonce.mockResolvedValue({ otcHash: 'hash', riskSignals: [] });
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
    mockValidateNonce.mockResolvedValue({ otcHash: 'hash', riskSignals: [] });
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null); // new user -> registration branch
    mockRegisterViaOTC.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 1000 });
    mockAddCredits.mockResolvedValue({ currentCredits: 1000 + EXPECTED_DOMAIN_CREDITS });
    mockPartnerGrant.mockResolvedValue({ matched: false, entitlements: new Set(), signupCredits: 0, tags: [] });
  });

  const firstTouch = `b4m-first-touch=${encodeURIComponent(JSON.stringify({ source: 'widgets' }))}`;

  it('scores the new account once it is registered', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(refreshSignupRiskScore).toHaveBeenCalledWith('user-1', req.logger);
    expect(mockRecordSignupNetwork.mock.invocationCallOrder[0]).toBeLessThan(
      refreshSignupRiskScore.mock.invocationCallOrder[0]
    );
  });

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

  it('strips secrets and undeclared fields from the registered user in the response', async () => {
    mockRegisterViaOTC.mockResolvedValue({
      id: 'user-1',
      tokenVersion: 0,
      currentCredits: 1000,
      ...secretUserFields(),
    });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    const body = res._getJSONData();
    expect(body.accessToken).toBe('a');
    expectSelfUserStripped(body.user, body, 'user-1');
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
    expect(mockRecordSignupNetwork).toHaveBeenCalledWith({ req, userId: 'user-1', method: 'otc' });
    expect(mockRecordLoginEvent).toHaveBeenCalledWith({ req, userId: 'user-1', method: 'otc-registration' });
    const user = { id: 'user-1', acquisition, isSynthetic: false };
    expect(mockEmitFunnelEvent).toHaveBeenCalledWith({ user, event: 'email_verified', metadata: { method: 'otc' } });
    expect(mockEmitFunnelEvent).toHaveBeenCalledWith({
      user,
      event: 'credits_granted',
      metadata: { amount: 1000, source: 'signup', method: 'otc' },
    });
  });

  it('returns the reserved-username rejection with a fresh token so the user can pick another name', async () => {
    mockRegisterViaOTC.mockRejectedValueOnce(new BadRequestError(RESERVED_USERNAME_MESSAGE));
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    req.body.username = 'persona-x';

    const err = await handler(req, res).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({
      message: RESERVED_USERNAME_MESSAGE,
      additionalInfo: { pendingToken: expect.any(String) },
    });
    expect(mockRegisterViaOTC).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'persona-x', email: NON_DOMAIN_EMAIL }),
      expect.anything()
    );
    expect(mockRecordSignupAcquisition).not.toHaveBeenCalled();
  });

  it('refuses an over-limit network before creating the account, with a fresh token', async () => {
    mockAssertSignupNetworkWithinLimits.mockRejectedValueOnce(new TooManyRequestsError('limited'));
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    const err = await handler(req, res).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TooManyRequestsError);
    expect(err).toMatchObject({ additionalInfo: { pendingToken: expect.any(String) } });
    expect(mockAssertSignupNetworkWithinLimits).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '203.0.113.5', asn: 64500 }),
      expect.anything()
    );
    expect(mockRegisterViaOTC).not.toHaveBeenCalled();
    // The refusal is not attacker-varying input, so retrying later does not burn the code.
    expect(mockJwtSign).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempts: 0 }),
      expect.anything(),
      expect.anything()
    );
  });

  it('exempts a partner-domain signup from the network caps', async () => {
    mockPartnerGrant.mockResolvedValue({ matched: true, entitlements: new Set(), signupCredits: 0, tags: [] });
    mockAssertSignupNetworkWithinLimits.mockRejectedValue(new TooManyRequestsError('limited'));
    mockRegisterViaOTC.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 1000 });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(mockAssertSignupNetworkWithinLimits).not.toHaveBeenCalled();
    expect(mockRegisterViaOTC).toHaveBeenCalled();
    mockAssertSignupNetworkWithinLimits.mockReset();
    mockAssertSignupNetworkWithinLimits.mockResolvedValue(undefined);
  });

  it("hands the request network's risk collector to the staged grant", async () => {
    mockRegisterViaOTC.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 1000 });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(mockRegisterViaOTC).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ collectRiskSignals: mockSignupRiskCollector })
    );
  });

  it.each([true, null, 'true'])('persists only a literal signed challenge pass (%s) before granting', async proof => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    mockJwtVerify.mockReturnValue({
      email: NON_DOMAIN_EMAIL,
      attempts: 0,
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: 'jti-1',
      challengeVerified: proof,
    });
    Object.assign(req.body, { challengeVerified: true });
    await handler(req, res);
    expect(mockRegisterViaOTC).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        signupMeta: expect.objectContaining({
          challengeVerified: proof === true ? true : null,
          capturedAt: expect.any(Date),
        }),
      })
    );
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

  it('reports credits_granted with zero when the signup seeded none', async () => {
    mockRegisterViaOTC.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 0 });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(mockEmitFunnelEvent.mock.calls.map(([c]) => [c.event, c.metadata])).toEqual([
      ['email_verified', { method: 'otc' }],
      ['credits_granted', { amount: 0, source: 'signup', method: 'otc' }],
      ['signup_completed', { method: 'otc' }],
    ]);
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
    expect(mockRecordSignupNetwork).not.toHaveBeenCalled();
    expect(mockRecordLoginEvent).toHaveBeenCalledWith({ req, userId: 'u-existing', method: 'otc' });
  });

  describe('OAuth source client', () => {
    const registerParams = () => mockRegisterViaOTC.mock.calls[0][0];

    it('passes a string sourceClientId and the OAuth client lookup to registration', async () => {
      const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
      (req as any).body.sourceClientId = 'b4m_acme_0a1b2c3d';

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(registerParams().sourceClientId).toBe('b4m_acme_0a1b2c3d');
      expect(mockRegisterViaOTC.mock.calls[0][1].db.oauthClients).toBe(oauthClientRepository);
      expect(mockRegisterViaOTC.mock.calls[0][1].db.signupProtection).toBe(signupProtection);
    });

    it.each([
      ['absent', undefined],
      ['empty', ''],
      ['a number', 42],
      ['an object', { $ne: null }],
      ['an array', ['b4m_acme_0a1b2c3d']],
      ['overlong', 'a'.repeat(129)],
    ])('drops a sourceClientId that is %s and still registers', async (_label, value) => {
      const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
      (req as any).body.sourceClientId = value;

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(mockRegisterViaOTC).toHaveBeenCalledTimes(1);
      expect(registerParams().sourceClientId).toBeUndefined();
    });

    it('never registers (so never tags) a returning user who arrives with a sourceClientId', async () => {
      mockFindByEmail.mockResolvedValue({
        id: 'u-existing',
        isSystem: false,
        isBanned: false,
        emailVerified: true,
        tokenVersion: 0,
        toJSON: () => ({ id: 'u-existing', username: 'bob' }),
      });
      const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
      (req as any).body.sourceClientId = 'b4m_acme_0a1b2c3d';

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(mockRegisterViaOTC).not.toHaveBeenCalled();
    });
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
      tags: ['Partner'],
    });
    const { req, res } = makeReqRes('person@newpartner.com');

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(domainGrantCall()?.[0]).toEqual(
      expect.objectContaining({ credits: 150_000, transactionId: 'domain-grant-credits:user-1' })
    );
    expect(mockAddTagsToUser).toHaveBeenCalledWith('user-1', ['Partner']);
  });

  it('honors a DB rule that grants access with 0 bonus credits (no env fallback)', async () => {
    // Even for an env-domain email, a matched rule with 0 credits must NOT fall back to
    // the env amount - `matched` distinguishes "0 on purpose" from "no rule".
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 0,
      tags: [],
    });
    const { req, res } = makeReqRes(DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(domainGrantCall()).toBeFalsy();
  });
});

describe('/api/otc/verify - new accounts per email domain', () => {
  const BURNER = 'alias@s1.burner.example';
  const domainKey = `otc-limit:register-domain-hourly:${otcEmailKey('burner.example')}`;
  const spent = { success: false, count: 5, expiresAt: new Date(Date.now() + 60_000) };
  const granted = { success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTryIncrement.mockImplementation(async key => (key === domainKey ? spent : granted));
    mockValidateNonce.mockResolvedValue('hash');
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null);
    mockRegisterViaOTC.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 0 });
    mockPartnerGrant.mockResolvedValue({ matched: false, entitlements: new Set(), signupCredits: 0, tags: [] });
    mockDomainEstablished.mockResolvedValue(false);
  });

  it('refuses a new account once the domain budget is spent, re-issuing the token to retry later', async () => {
    const { req, res } = makeReqRes(BURNER);

    await expect(handler(req, res)).rejects.toMatchObject({
      statusCode: 429,
      additionalInfo: { pendingToken: expect.any(String) },
    });
    expect(res.getHeader('Retry-After')).toBeDefined();
    expect(mockRegisterViaOTC).not.toHaveBeenCalled();
    expect(mockDomainEstablished).toHaveBeenCalledWith('burner.example', expect.any(Date));
  });

  it('admits a new account on an established domain even with the budget spent', async () => {
    mockDomainEstablished.mockResolvedValue(true);
    const { req, res } = makeReqRes(BURNER);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRegisterViaOTC).toHaveBeenCalledTimes(1);
  });

  it('hands the domain units back when registration fails', async () => {
    mockTryIncrement.mockResolvedValue(granted);
    mockRegisterViaOTC.mockRejectedValue(new UnprocessableEntityError('Username taken'));
    const { req, res } = makeReqRes(BURNER);

    await expect(handler(req, res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockDecrement).toHaveBeenCalledWith(domainKey);
    expect(mockDecrement).toHaveBeenCalledWith(`otc-limit:register-domain-daily:${otcEmailKey('burner.example')}`);
  });

  it('never charges a personal mail provider or a sign-in', async () => {
    const gmail = makeReqRes('someone@gmail.com');
    await handler(gmail.req, gmail.res);

    mockFindByEmail.mockResolvedValue({ id: 'u-1', isSystem: false, isBanned: false, emailVerified: true, tags: [] });
    const signIn = makeReqRes(BURNER);
    await handler(signIn.req, signIn.res);

    expect(mockTryIncrement).not.toHaveBeenCalledWith(
      expect.stringMatching(/^otc-limit:register-domain/),
      expect.anything(),
      expect.anything()
    );
  });

  it('does not cap a partner domain, even with the budget spent', async () => {
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      ruleId: 'rule-1',
      domain: 'burner.example',
      entitlements: new Set(),
      signupCredits: 0,
      organizationId: null,
      tags: [],
      subscription: null,
    });
    const { req, res } = makeReqRes(BURNER);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRegisterViaOTC).toHaveBeenCalledTimes(1);
    expect(mockTryIncrement).not.toHaveBeenCalledWith(
      expect.stringMatching(/^otc-limit:register-domain/),
      expect.anything(),
      expect.anything()
    );
    expect(mockDomainEstablished).not.toHaveBeenCalled();
  });

  it('does not cap a self-host install', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    try {
      const { req, res } = makeReqRes(BURNER);
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockDomainEstablished).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('/api/otc/verify - existing user verification and pending free credits', () => {
  // The handler mutates the doc in place and the login response serializes it through toJSON(),
  // so the fixture must expose the CURRENT fields - a fixed toJSON would hide an unreflected grant.
  const pendingUser = (overrides: Record<string, unknown> = {}) => {
    const user: Record<string, unknown> = {
      id: 'u-existing',
      isSystem: false,
      isBanned: false,
      emailVerified: false,
      tags: ['Customer', PENDING_FREE_CREDITS_TAG],
      pendingCreditGrant: null,
      tokenVersion: 0,
      ...overrides,
    };
    user.toJSON = () => ({ ...user });
    return user;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
    mockValidateNonce.mockResolvedValue({ otcHash: 'hash', riskSignals: [] });
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockUserUpdate.mockResolvedValue(undefined);
    mockPartnerGrant.mockResolvedValue({ matched: false, entitlements: new Set(), signupCredits: 0, tags: [] });
    mockAddCredits.mockResolvedValue({ currentCredits: 15_000 });
    mockApplyPartnerRuleMembership.mockResolvedValue({ added: true, reason: 'added' });
  });

  const partnerRuleGrant = () =>
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['partner:pro']),
      signupCredits: 15_000,
      organizationId: 'org-partner',
      tags: ['Partner'],
    });

  it('mints no second session when a proven code and token are replayed', async () => {
    mockFindByEmail.mockResolvedValue(pendingUser({ emailVerified: true, tags: ['Customer'] }));
    // A proven nonce is rotated away, so the store no longer holds it on replay (see the
    // 'rotation retires the presented nonce for replay' repository test).
    mockValidateNonce.mockResolvedValueOnce('hash').mockResolvedValueOnce(null);

    const first = makeReqRes(NON_DOMAIN_EMAIL);
    await handler(first.req, first.res);
    expect(first.res._getStatusCode()).toBe(200);

    const replay = makeReqRes(NON_DOMAIN_EMAIL);
    await expect(handler(replay.req, replay.res)).rejects.toMatchObject({ message: 'Invalid code.' });
    expect(authSessionService.issueSession).toHaveBeenCalledTimes(1);
    // Both attempts present the token's own nonce, so the store's rotation is what refuses the replay.
    expect(mockValidateNonce).toHaveBeenNthCalledWith(2, NON_DOMAIN_EMAIL, 'jti-1', expect.any(String));
  });

  it('strips secrets and undeclared fields from the flat login body', async () => {
    // Deliberately not `pendingUser`: a loosened schema has to fail on a leaked secret, and a
    // toJSON on the seeded doc would instead serialize the login body without the accessToken.
    mockFindByEmail.mockResolvedValue({
      id: 'u-existing',
      isSystem: false,
      isBanned: false,
      emailVerified: true,
      tags: ['Customer'],
      pendingCreditGrant: null,
      tokenVersion: 0,
      ...secretUserFields(),
    });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    const body = res._getJSONData();
    expect(body.accessToken).toBe('a');
    expectSelfUserStripped(body, body, 'u-existing');
  });

  it('stamps emailVerified first, then strips the pending-credit tag in a separate write', async () => {
    mockFindByEmail.mockResolvedValue(pendingUser({ pendingCreditGrant: 250 }));
    mockReleasePending.mockResolvedValue({
      released: true,
      creditsGranted: 100,
      currentCredits: 100,
      patch: { tags: ['Customer'], pendingCreditGrant: null },
    });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledTimes(1);
    expect(mockUserUpdate).toHaveBeenNthCalledWith(1, {
      id: 'u-existing',
      emailVerified: true,
      emailVerifiedAt: expect.any(Date),
      emailVerificationToken: null,
      emailVerificationExpires: null,
      emailVerificationSentAt: null,
    });
    expect(mockClearPending).toHaveBeenCalledWith('u-existing');
    // The release is reflected onto the response, not just the doc the handler mutated.
    expect(res._getJSONData()).toMatchObject({ tags: ['Customer'], pendingCreditGrant: null });
  });

  it('reports email_verified and the summed credits on the first verifying login', async () => {
    mockFindByEmail.mockResolvedValue(pendingUser({ pendingCreditGrant: 250 }));
    mockReleasePending.mockResolvedValue({
      released: true,
      creditsGranted: 100,
      currentCredits: 100,
      patch: { tags: ['Customer'], pendingCreditGrant: null },
    });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockEmitVerifiedFunnel).toHaveBeenCalledTimes(1);
    expect(mockEmitVerifiedFunnel).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'u-existing' }),
      method: 'otc',
      creditsGranted: 100,
    });
  });

  it('leaves an already-verified user untouched', async () => {
    mockFindByEmail.mockResolvedValue(pendingUser({ emailVerified: true }));
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockEmitVerifiedFunnel).not.toHaveBeenCalled();
    expect(mockReleasePending).not.toHaveBeenCalled();
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('still stamps emailVerified and logs the user in when the grant fails', async () => {
    mockFindByEmail.mockResolvedValue(pendingUser());
    mockReleasePending.mockResolvedValue({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith({
      id: 'u-existing',
      emailVerified: true,
      emailVerifiedAt: expect.any(Date),
      emailVerificationToken: null,
      emailVerificationExpires: null,
      emailVerificationSentAt: null,
    });
  });

  it('applies the verified domain grant (credits and partner org) to an unverified existing user', async () => {
    partnerRuleGrant();
    const user = pendingUser();
    mockFindByEmail.mockResolvedValue(user);
    mockReleasePending.mockResolvedValue({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });
    const { req, res } = makeReqRes(DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    // Reflected onto the doc the response serializes, so the client sees the grant without a refetch.
    expect(user).toMatchObject({ currentCredits: 15_000, organizationId: 'org-partner' });
    expect(res._getJSONData()).toMatchObject({ currentCredits: 15_000, organizationId: 'org-partner' });
    expect(mockAddTagsToUser).toHaveBeenCalledWith('u-existing', ['Partner']);
    expect(res._getJSONData().tags).toEqual(['Customer', PENDING_FREE_CREDITS_TAG, 'Partner']);
    expect(mockAddCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'u-existing',
        credits: 15_000,
        transactionId: 'domain-grant-credits:u-existing',
      }),
      expect.anything()
    );
    expect(mockApplyPartnerRuleMembership).toHaveBeenCalledWith(
      { userId: 'u-existing', organizationId: 'org-partner' },
      expect.anything()
    );
  });

  it('does not apply the domain grant to an already-verified existing user', async () => {
    partnerRuleGrant();
    mockFindByEmail.mockResolvedValue(pendingUser({ emailVerified: true }));
    const { req, res } = makeReqRes(DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockPartnerGrant).not.toHaveBeenCalled();
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(mockApplyPartnerRuleMembership).not.toHaveBeenCalled();
  });

  it('does not apply the domain grant when persisting emailVerified fails (next login retries)', async () => {
    partnerRuleGrant();
    mockFindByEmail.mockResolvedValue(pendingUser());
    mockReleasePending.mockResolvedValue({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });
    mockUserUpdate.mockRejectedValue(new Error('db down'));
    const { req, res } = makeReqRes(DOMAIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockPartnerGrant).not.toHaveBeenCalled();
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(mockApplyPartnerRuleMembership).not.toHaveBeenCalled();
  });
});

describe('/api/otc/verify - partner-domain invite bypass', () => {
  const PARTNER_EMAIL = 'new.person@partner.example';
  const matchedGrant = {
    matched: true,
    ruleId: 'rule-1',
    domain: 'partner.example',
    entitlements: new Set(),
    signupCredits: 0,
    organizationId: null,
    tags: [],
    subscription: null,
  };
  const noGrant = { matched: false, entitlements: new Set(), signupCredits: 0, tags: [] };
  const skipInviteCheckArg = () => mockRegisterViaOTC.mock.calls[0][1].skipInviteCheck;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
    mockValidateNonce.mockResolvedValue({ otcHash: 'hash', riskSignals: [] });
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null);
    mockRegisterViaOTC.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 0 });
    mockPartnerGrant.mockResolvedValue(noGrant);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('forwards a validated invite without skipping the registration gate', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    req.body.inviteCode = ' INVITE123 ';
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockRegisterViaOTC).toHaveBeenCalledWith(
      expect.objectContaining({ inviteCode: 'INVITE123', email: NON_DOMAIN_EMAIL }),
      expect.objectContaining({ skipInviteCheck: false })
    );
  });

  it.each([undefined, '', '   '])('registers without an invite outside a transaction (%j)', async inviteCode => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    req.body.inviteCode = inviteCode;
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockRegisterViaOTC).toHaveBeenCalledTimes(1);
  });

  it('keeps existing-account sign-in outside the invite transaction', async () => {
    mockFindByEmail.mockResolvedValue({ id: 'existing-user', emailVerified: true, tokenVersion: 0 });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    req.body.inviteCode = 'INVITE123';
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockRegisterViaOTC).not.toHaveBeenCalled();
  });

  it.each([123, {}, ['INVITE123'], null])(
    'rejects malformed invite input %j before consuming the code',
    async inviteCode => {
      const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
      req.body.inviteCode = inviteCode;
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(mockRegisterViaOTC).not.toHaveBeenCalled();
      expect(mockValidateNonce).not.toHaveBeenCalled();
    }
  );

  it('skips the invite check once the code proves an email on an enabled partner rule', async () => {
    mockPartnerGrant.mockResolvedValue(matchedGrant);
    const { req, res } = makeReqRes(PARTNER_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockPartnerGrant).toHaveBeenCalledWith(PARTNER_EMAIL, true);
    expect(skipInviteCheckArg()).toBe(true);
  });

  it('checks the normalized email, not the raw input', async () => {
    mockPartnerGrant.mockResolvedValue(matchedGrant);
    const { req, res } = makeReqRes(PARTNER_EMAIL);
    req.body.email = '  New.Person@PARTNER.example ';

    await handler(req, res);

    expect(mockPartnerGrant).toHaveBeenCalledWith(PARTNER_EMAIL, true);
    expect(skipInviteCheckArg()).toBe(true);
  });

  it('admits a verified partner email to username entry on an invite-only instance', async () => {
    mockPartnerGrant.mockResolvedValue(matchedGrant);
    const { req, res } = makeReqRes('  New.Person@PARTNER.example ');
    req.body.username = undefined;

    await handler(req, res);

    expect(res._getJSONData()).toMatchObject({
      registrationRequired: true,
      registrationAllowed: true,
      email: PARTNER_EMAIL,
      pendingToken: 'signed-token',
    });
    expect(mockPartnerGrant).toHaveBeenCalledWith(PARTNER_EMAIL, true);
    expect(mockRegisterViaOTC).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'reports registrationAllowed=%s for a non-partner using the open-registration setting',
    async open => {
      mockFindSetting.mockResolvedValue({ settingValue: open });
      const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
      req.body.username = undefined;

      await handler(req, res);

      expect(res._getJSONData()).toMatchObject({ registrationRequired: true, registrationAllowed: open });
      expect(mockRegisterViaOTC).not.toHaveBeenCalled();
    }
  );

  it('admits the self-host bootstrap user to username entry without a partner rule', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', '');
    const { userRepository } = await import('@bike4mind/database');
    vi.mocked(userRepository.count).mockResolvedValue(0);
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    req.body.username = undefined;

    await handler(req, res);

    expect(res._getJSONData()).toMatchObject({ registrationRequired: true, registrationAllowed: true });
    expect(mockPartnerGrant).not.toHaveBeenCalled();
  });

  it('keeps the invite check for a domain with no enabled rule even if the client claims admission', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    req.body.registrationAllowed = true;

    await handler(req, res);

    expect(skipInviteCheckArg()).toBe(false);
  });

  it('rechecks partner admission when creating the account after the username step', async () => {
    mockPartnerGrant.mockResolvedValue(matchedGrant);
    const first = makeReqRes(PARTNER_EMAIL);
    first.req.body.username = undefined;
    await handler(first.req, first.res);
    expect(first.res._getJSONData().registrationAllowed).toBe(true);

    mockPartnerGrant.mockResolvedValue(noGrant);
    const second = makeReqRes(PARTNER_EMAIL);
    await handler(second.req, second.res);

    expect(skipInviteCheckArg()).toBe(false);
  });

  it('never consults the rules before the code is proven', async () => {
    mockPartnerGrant.mockResolvedValue(matchedGrant);
    mockVerifyPendingOTC.mockResolvedValue(false);
    const { req, res } = makeReqRes(PARTNER_EMAIL);

    await handler(req, res).catch(() => undefined);

    expect(mockPartnerGrant).not.toHaveBeenCalled();
    expect(mockRegisterViaOTC).not.toHaveBeenCalled();
  });

  it('leaves the self-host bootstrap bypass unchanged', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', '');
    const { userRepository } = await import('@bike4mind/database');
    vi.mocked(userRepository.count).mockResolvedValue(0);
    mockUserUpdate.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 0, isAdmin: true });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);

    await handler(req, res);

    expect(skipInviteCheckArg()).toBe(true);
  });
});

describe('/api/otc/verify - self-host bootstrap admin', () => {
  const ADMIN_EMAIL = 'owner@example.com';
  const OTHER_EMAIL = 'someone@example.com';
  const skipInviteCheckArg = (call = 0) => mockRegisterViaOTC.mock.calls[call][1].skipInviteCheck;
  const warnOf = (req: object) => (req as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn;
  const errorOf = (req: object) => (req as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error;
  const adminPromotions = () => mockUserUpdate.mock.calls.filter(([update]) => update.isAdmin === true);

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('B4M_SELF_HOST', 'true');
    mockTryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
    mockValidateNonce.mockResolvedValue({ otcHash: 'hash', riskSignals: [] });
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null);
    mockRegisterViaOTC.mockImplementation(async ({ email }: { email: string }) => ({
      id: `user-${email}`,
      tokenVersion: 0,
      currentCredits: 0,
    }));
    mockUserUpdate.mockImplementation(async (update: { id: string }) => ({ ...update, tokenVersion: 0 }));
    const { userRepository } = await import('@bike4mind/database');
    vi.mocked(userRepository.count).mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('promotes the account whose email matches the configured bootstrap email', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', '  Owner@Example.com ');
    const { req, res } = makeReqRes(ADMIN_EMAIL);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(skipInviteCheckArg()).toBe(true);
    expect(adminPromotions()).toEqual([[{ id: `user-${ADMIN_EMAIL}`, isAdmin: true }]]);
    expect(warnOf(req)).not.toHaveBeenCalled();
  });

  it('registers any other first account under the normal rules, without admin', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL);
    const { req, res } = makeReqRes(OTHER_EMAIL);

    await handler(req, res);

    expect(mockClaimOnce).not.toHaveBeenCalled();
    expect(skipInviteCheckArg()).toBe(false);
    expect(adminPromotions()).toHaveLength(0);
  });

  it('reports registration as closed for another email on an invite-only install', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL);
    const { req, res } = makeReqRes(OTHER_EMAIL);
    req.body.username = undefined;

    await handler(req, res);

    expect(res._getJSONData()).toMatchObject({ registrationRequired: true, registrationAllowed: false });
  });

  it('admits the configured email to username entry on an invite-only install', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL);
    const { req, res } = makeReqRes(ADMIN_EMAIL);
    req.body.username = undefined;

    await handler(req, res);

    expect(res._getJSONData()).toMatchObject({ registrationRequired: true, registrationAllowed: true });
    expect(mockClaimOnce).not.toHaveBeenCalled();
  });

  it('promotes the first account and warns when no bootstrap email is configured', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', '');
    const { req, res } = makeReqRes(OTHER_EMAIL);

    await handler(req, res);

    expect(adminPromotions()).toHaveLength(1);
    expect(warnOf(req)).toHaveBeenCalledWith(expect.stringContaining('B4M_BOOTSTRAP_ADMIN_EMAIL'));
  });

  it('never promotes once any user exists', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL);
    const { userRepository } = await import('@bike4mind/database');
    vi.mocked(userRepository.count).mockResolvedValue(1);
    const { req, res } = makeReqRes(ADMIN_EMAIL);

    await handler(req, res);

    expect(mockClaimOnce).not.toHaveBeenCalled();
    expect(skipInviteCheckArg()).toBe(false);
    expect(adminPromotions()).toHaveLength(0);
  });

  it('never promotes outside self-host', async () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL);
    const { req, res } = makeReqRes(ADMIN_EMAIL);

    await handler(req, res);

    expect(mockClaimOnce).not.toHaveBeenCalled();
    expect(adminPromotions()).toHaveLength(0);
  });

  it('promotes exactly one of two concurrent first registrations', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', '');
    const first = makeReqRes(OTHER_EMAIL);
    const firstReq = first.req;
    const second = makeReqRes('another@example.com');
    // makeReqRes points the shared jwt stub at its own email, so pin each request's payload.
    mockJwtVerify.mockImplementation((token: string) => ({
      email: token === 'second-token' ? 'another@example.com' : OTHER_EMAIL,
      attempts: 0,
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: 'jti-1',
    }));
    second.req.body.pendingToken = 'second-token';

    await Promise.all([handler(firstReq, first.res), handler(second.req, second.res)]);

    expect(mockClaimOnce).toHaveBeenCalledTimes(2);
    expect(adminPromotions()).toHaveLength(1);
    expect([skipInviteCheckArg(0), skipInviteCheckArg(1)].sort()).toEqual([false, true]);
  });

  it('passes the stale-claim window to the claim', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL);
    const { req, res } = makeReqRes(ADMIN_EMAIL);

    await handler(req, res);

    expect(mockClaimOnce).toHaveBeenCalledWith('selfHostBootstrap', expect.any(String), 300_000);
  });

  it('frees the winning claim when the bootstrap registration fails', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL);
    mockRegisterViaOTC.mockRejectedValueOnce(new Error('db down'));
    const failed = makeReqRes(ADMIN_EMAIL);
    await handler(failed.req, failed.res).catch(() => undefined);
    expect(mockReleaseClaim).toHaveBeenCalledTimes(1);
    expect(mockReleaseClaim).toHaveBeenCalledWith('selfHostBootstrap', mockClaimOnce.mock.calls[0][1]);

    const retry = makeReqRes(ADMIN_EMAIL);
    await handler(retry.req, retry.res);

    expect(adminPromotions()).toHaveLength(1);
  });

  it('still returns the registration error and a fresh token when releasing the claim fails', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL);
    mockRegisterViaOTC.mockRejectedValueOnce(new Error('db down'));
    mockReleaseClaim.mockRejectedValueOnce(new Error('release down'));
    const { req, res } = makeReqRes(ADMIN_EMAIL);

    const err = await handler(req, res).catch((e: unknown) => e);

    expect(err).toMatchObject({ additionalInfo: { pendingToken: expect.any(String) } });
    expect(errorOf(req)).toHaveBeenCalledWith('Self-host bootstrap claim release failed', expect.any(Error));
  });

  it('does not release a claim it lost when its own registration fails', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', '');
    claims.set('selfHostBootstrap', 'someone-elses-claim');
    mockRegisterViaOTC.mockRejectedValueOnce(new Error('db down'));
    const { req, res } = makeReqRes(OTHER_EMAIL);

    await handler(req, res).catch(() => undefined);

    expect(mockReleaseClaim).not.toHaveBeenCalled();
    expect(claims.get('selfHostBootstrap')).toBe('someone-elses-claim');
  });

  it('re-issues the token when the claim itself fails', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL);
    mockClaimOnce.mockRejectedValueOnce(new Error('db down'));
    const { req, res } = makeReqRes(ADMIN_EMAIL);

    const err = await handler(req, res).catch((e: unknown) => e);

    expect(err).toMatchObject({ additionalInfo: { pendingToken: expect.any(String) } });
    expect(mockRegisterViaOTC).not.toHaveBeenCalled();
    expect(mockReleaseClaim).not.toHaveBeenCalled();
  });

  describe('configured admin whose account exists without admin rights', () => {
    const existing = { id: 'user-existing', email: ADMIN_EMAIL, emailVerified: true, tokenVersion: 0 };

    beforeEach(async () => {
      vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL);
      mockFindByEmail.mockResolvedValue({ ...existing });
      const { userRepository } = await import('@bike4mind/database');
      vi.mocked(userRepository.count).mockResolvedValue(0);
    });

    it('promotes on sign-in when the install has no admin', async () => {
      const { userRepository } = await import('@bike4mind/database');
      vi.mocked(userRepository.count).mockImplementation(async (filter?: object) =>
        filter && 'isAdmin' in filter ? 0 : 1
      );
      const { req, res } = makeReqRes(ADMIN_EMAIL);

      await handler(req, res);

      expect(adminPromotions()).toEqual([[{ id: 'user-existing', isAdmin: true }]]);
    });

    it('still signs in when the promotion write fails', async () => {
      const { userRepository } = await import('@bike4mind/database');
      vi.mocked(userRepository.count).mockImplementation(async (filter?: object) =>
        filter && 'isAdmin' in filter ? 0 : 1
      );
      mockUserUpdate.mockRejectedValueOnce(new Error('write failed'));
      const { req, res } = makeReqRes(ADMIN_EMAIL);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(warnOf(req)).toHaveBeenCalledWith(expect.stringContaining('promotion failed'), expect.anything());
    });

    it('does not promote when the install already has an admin', async () => {
      const { userRepository } = await import('@bike4mind/database');
      vi.mocked(userRepository.count).mockResolvedValue(1);
      const { req, res } = makeReqRes(ADMIN_EMAIL);

      await handler(req, res);

      expect(adminPromotions()).toHaveLength(0);
    });

    it('does not promote an account that is not the configured email', async () => {
      mockFindByEmail.mockResolvedValue({ ...existing, email: OTHER_EMAIL });
      const { req, res } = makeReqRes(OTHER_EMAIL);

      await handler(req, res);

      expect(adminPromotions()).toHaveLength(0);
    });
  });
});

describe('/api/otc/verify - signup bot-check signals', () => {
  const signals = ['signup_too_fast', 'signup_honeypot'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockTryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
    mockValidateNonce.mockResolvedValue({ otcHash: 'hash', riskSignals: [] });
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null);
    mockRegisterViaOTC.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 0 });
    mockPartnerGrant.mockResolvedValue({ matched: false, entitlements: new Set(), signupCredits: 0, tags: [] });
    mockSetThrottleTier.mockResolvedValue({ changed: true, before: 'none', after: 'shadow' });
    vi.mocked(getSettingsMap).mockResolvedValue({} as never);
    vi.mocked(getSettingsValue).mockReturnValue(true as never);
  });

  const withSignals = (list: string[]) => mockValidateNonce.mockResolvedValue({ otcHash: 'hash', riskSignals: list });

  it('applies signals to a newly created account and audits as a system actor', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(signals);

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith({
      id: 'user-1',
      riskSignals: signals.map(type => ({ type, at: expect.any(Date) })),
    });
    expect(mockSetThrottleTier).toHaveBeenCalledWith(
      'user-1',
      'shadow',
      { reason: 'signup checks: signup_too_fast,signup_honeypot', source: 'signup_honeypot' },
      expect.anything()
    );
    expect(mockRecordAdminActionForActor).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ kind: 'system', name: 'signup-checks' }),
      expect.objectContaining({
        action: 'user.throttle_tier.changed',
        changes: [{ field: 'throttle.tier', before: 'none', after: 'shadow' }],
      })
    );
  });

  it('records a lone missing form token without shadowing the account', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(['signup_token_missing']);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith({
      id: 'user-1',
      riskSignals: [{ type: 'signup_token_missing', at: expect.any(Date) }],
    });
    expect(mockSetThrottleTier).not.toHaveBeenCalled();
    expect(mockRecordAdminActionForActor).not.toHaveBeenCalled();
  });

  it('records a lone expired form token without shadowing the account', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(['signup_token_expired']);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith({
      id: 'user-1',
      riskSignals: [{ type: 'signup_token_expired', at: expect.any(Date) }],
    });
    expect(mockSetThrottleTier).not.toHaveBeenCalled();
    expect(mockRecordAdminActionForActor).not.toHaveBeenCalled();
  });

  it('records a lone too-fast submission without shadowing the account', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(['signup_too_fast']);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith({
      id: 'user-1',
      riskSignals: [{ type: 'signup_too_fast', at: expect.any(Date) }],
    });
    expect(mockSetThrottleTier).not.toHaveBeenCalled();
    expect(mockRecordAdminActionForActor).not.toHaveBeenCalled();
  });

  it('shadows too-fast plus an invalid token with the timing source', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(['signup_too_fast', 'signup_token_invalid']);
    await handler(req, res);
    expect(mockSetThrottleTier).toHaveBeenCalledWith(
      'user-1',
      'shadow',
      { reason: 'signup checks: signup_too_fast,signup_token_invalid', source: 'signup_timing' },
      expect.anything()
    );
  });

  it('shadows an expired token plus honeypot with the honeypot source', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(['signup_token_expired', 'signup_honeypot']);
    await handler(req, res);
    expect(mockSetThrottleTier).toHaveBeenCalledWith(
      'user-1',
      'shadow',
      { reason: 'signup checks: signup_token_expired,signup_honeypot', source: 'signup_honeypot' },
      expect.anything()
    );
  });

  it('shadows with the source of the first non-missing signal', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(['signup_token_missing', 'signup_honeypot']);
    await handler(req, res);
    expect(mockSetThrottleTier).toHaveBeenCalledWith(
      'user-1',
      'shadow',
      { reason: 'signup checks: signup_token_missing,signup_honeypot', source: 'signup_honeypot' },
      expect.anything()
    );
  });

  it('skips recording and the tier change when the kill switch was turned off after the code was issued', async () => {
    vi.mocked(getSettingsValue).mockReturnValue(false as never);
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(signals);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSetThrottleTier).not.toHaveBeenCalled();
    expect(mockUserUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ riskSignals: expect.anything() }));
  });

  it('keeps applying stored signals when the setting read fails', async () => {
    // Keyed on the bot-check read: other getSettingsMap callers in the handler must not consume the failure.
    vi.mocked(getSettingsMap).mockImplementation(async (_adapters, query) => {
      if (query?.names?.includes('signupBotChecksEnabled')) throw new Error('db down');
      return {};
    });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(signals);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSetThrottleTier).toHaveBeenCalled();
  });

  it('does nothing for a new account without signals', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSetThrottleTier).not.toHaveBeenCalled();
    expect(mockRecordAdminActionForActor).not.toHaveBeenCalled();
  });

  it('ignores signals when an existing user logs in', async () => {
    mockFindByEmail.mockResolvedValue({ id: 'user-9', email: NON_DOMAIN_EMAIL, emailVerified: true, tags: [] });
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(signals);
    await handler(req, res);
    expect(mockSetThrottleTier).not.toHaveBeenCalled();
    expect(mockUserUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ riskSignals: expect.anything() }));
  });

  it('keeps signals out of the re-issued token when registration still needs a username', async () => {
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    req.body.username = undefined;
    withSignals(signals);
    await handler(req, res);
    expect(res._getJSONData()).toMatchObject({ registrationRequired: true });
    expect(mockJwtSign.mock.calls.at(-1)?.[0]).not.toHaveProperty('rs');
  });

  it('keeps signals out of the re-issued token after a wrong code', async () => {
    mockVerifyPendingOTC.mockResolvedValue(false);
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(signals);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(mockJwtSign.mock.calls.at(-1)?.[0]).not.toHaveProperty('rs');
  });

  it('does not fail signup or change the response when applying signals throws', async () => {
    mockSetThrottleTier.mockRejectedValue(new Error('db down'));
    const clean = makeReqRes(NON_DOMAIN_EMAIL);
    await handler(clean.req, clean.res);
    const { req, res } = makeReqRes(NON_DOMAIN_EMAIL);
    withSignals(signals);
    await handler(req, res);
    expect(mockSetThrottleTier).toHaveBeenCalledWith(
      'user-1',
      'shadow',
      expect.objectContaining({ source: 'signup_honeypot' }),
      expect.anything()
    );
    expect(res._getStatusCode()).toBe(clean.res._getStatusCode());
    expect(res._getJSONData()).toEqual(clean.res._getJSONData());
    expect((req as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('set throttle tier'),
      expect.objectContaining({ userId: 'user-1', signals })
    );
  });
});
