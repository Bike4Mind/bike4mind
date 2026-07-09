import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CreditHolderType } from '@bike4mind/common';
import { signupCreditsForEmail } from '@client/lib/entitlements/registry';

// Middleware is stripped so the handler body runs directly (same pattern as the
// email/verify suite). baseApi().use(...).use(...).post(fn) must chain and hand back
// the raw handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next?.(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: any) => next?.() }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn(() => Promise.resolve()) }));
vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
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
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: vi.fn() },
  registrationInviteRepository: {},
  subscriberRepository: {},
  creditTransactionRepository: {},
  userRepository: { findByEmail: (...a: any[]) => mockFindByEmail(...a), count: vi.fn(), update: vi.fn() },
  pendingOtcTokenRepository: { validateAndRotateNonce: (...a: any[]) => mockValidateNonce(...a) },
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
}));

import handler from '@pages/api/otc/verify';

// bike4mind.com is seeded as an internal-staff domain in vitest.setup.ts, so the real
// registry confers optihashi:pro -> its signup-credit total for this address.
const DOMAIN_EMAIL = 'newstaff@bike4mind.com';
const NON_DOMAIN_EMAIL = 'nobody@example.com';
const EXPECTED_DOMAIN_CREDITS = signupCreditsForEmail(DOMAIN_EMAIL, true);

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
    otcHash: 'hash',
    attempts: 0,
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: 'jti-1',
  });
  return { req, res };
}

const domainGrantCall = () =>
  mockAddCredits.mock.calls.find(([p]) => p.transactionId === 'domain-grant-credits:user-1');

describe('/api/otc/verify — domain-grant signup credits (Register now flow)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateNonce.mockResolvedValue(true);
    mockVerifyPendingOTC.mockResolvedValue(true);
    mockFindByEmail.mockResolvedValue(null); // new user -> registration branch
    mockRegisterViaOTC.mockResolvedValue({ id: 'user-1', tokenVersion: 0, currentCredits: 1000 });
    mockAddCredits.mockResolvedValue({ currentCredits: 1000 + EXPECTED_DOMAIN_CREDITS });
    mockPartnerGrant.mockResolvedValue({ matched: false, entitlements: new Set(), signupCredits: 0 });
  });

  it('is a sanity check that the fixture domain actually confers the product credit sum', () => {
    // Guards the suite: if bike4mind.com ever stops conferring the product, the credit
    // assertions below would silently pass on 0.
    expect(EXPECTED_DOMAIN_CREDITS).toBe(250_000);
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
        credits: EXPECTED_DOMAIN_CREDITS,
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
