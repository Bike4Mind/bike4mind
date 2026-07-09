import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CreditHolderType, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { signupCreditsForEmail } from '@client/lib/entitlements/registry';

// Middleware is stripped so the handler body runs directly (same pattern as
// pages/api/auth/__tests__/unlink.test.ts). baseApi().use(...).use(...).post(fn)
// must chain and hand back the raw handler.
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => (_req: any, _res: any, next: any) => next?.(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: any) => next?.() }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/auditLog', () => ({
  logAuditEvent: vi.fn(),
  EmailAuditEvents: {
    EMAIL_VERIFICATION_FAILED: 'failed',
    EMAIL_VERIFICATION_TOKEN_REUSED: 'reused',
    EMAIL_VERIFICATION_TOKEN_EXPIRED: 'expired',
    EMAIL_VERIFICATION_SUCCESS: 'success',
  },
  calculateTokenAge: vi.fn(() => 0),
}));
vi.mock('@server/entitlements/invalidate', () => ({ pushEntitlementInvalidation: vi.fn() }));

// DB-backed partner rules (issue #293). Default to "no rule" so the existing cases
// fall through to the env registry exactly as before; DB-precedence cases set a match.
const mockPartnerGrant = vi.fn();
vi.mock('@server/entitlements/partnerRules', () => ({
  partnerSignupGrantForEmail: (...a: any[]) => mockPartnerGrant(...a),
}));

const mockFindByToken = vi.fn();
const mockUpdate = vi.fn();
const mockFindBySettingName = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findByEmailVerificationToken: (...a: any[]) => mockFindByToken(...a),
    update: (...a: any[]) => mockUpdate(...a),
  },
  withTransaction: (fn: any) => fn(),
  adminSettingsRepository: { findBySettingName: (...a: any[]) => mockFindBySettingName(...a) },
  creditTransactionRepository: {},
}));

const mockVerifyEmailToken = vi.fn();
const mockAddCredits = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: { verifyEmailToken: (...a: any[]) => mockVerifyEmailToken(...a) },
  creditService: { addCredits: (...a: any[]) => mockAddCredits(...a) },
}));

import handler from '@pages/api/email/verify';

// Our own internal staff domain - a real DOMAIN_GRANT_ROWS entry conferring the
// single OptiHashi product tier, so the real registry sums to its signup credit total.
// (The former Q/Work tier was folded into optihashi:pro, so this is now a
// one-product grant, not two.)
const DOMAIN_EMAIL = 'staff@bike4mind.com';
const NON_DOMAIN_EMAIL = 'nobody@example.com';
const EXPECTED_DOMAIN_CREDITS = signupCreditsForEmail(DOMAIN_EMAIL, true);

function makeReqRes() {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).body = { token: 'tok-123' };
  (req as any).ip = '127.0.0.1';
  (req as any).headers = { 'user-agent': 'test' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

function mockUser(overrides: { email?: string; tags?: string[]; pendingCreditGrant?: number | null } = {}) {
  const { email = DOMAIN_EMAIL, tags = [], pendingCreditGrant = null } = overrides;
  mockFindByToken.mockResolvedValue({
    id: 'user-1',
    email,
    tags,
    pendingCreditGrant,
    emailVerificationSentAt: new Date(),
  });
}

const domainGrantCall = () =>
  mockAddCredits.mock.calls.find(([p]) => p.transactionId === 'domain-grant-credits:user-1');
const flatGrantCall = () => mockAddCredits.mock.calls.find(([p]) => p.transactionId === 'verify-grant:user-1');

describe('/api/email/verify — domain-grant signup credits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyEmailToken.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
    mockAddCredits.mockResolvedValue({});
    mockFindBySettingName.mockResolvedValue({ settingValue: 1000 });
    mockPartnerGrant.mockResolvedValue({ matched: false, entitlements: new Set(), signupCredits: 0 });
  });

  it('is a sanity check that the fixture domain actually confers the product credit sum', () => {
    // Guards the rest of the suite: if bike4mind.com ever stops conferring the
    // product, these assertions would silently pass on 0 credits. Single-product
    // (optihashi:pro) since the Q/Work tier fold; was 500_000 (two products).
    expect(EXPECTED_DOMAIN_CREDITS).toBe(250_000);
  });

  it('grants domain-grant signup credits to a verified domain user with NO pending-free-credits tag', async () => {
    mockUser({ email: DOMAIN_EMAIL, tags: [] });
    const { req, res } = makeReqRes();

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
    // No pending tag -> the flat defaultFreeCredits grant must NOT fire.
    expect(flatGrantCall()).toBeFalsy();
    expect(mockFindBySettingName).not.toHaveBeenCalled();
  });

  it('does NOT grant domain credits to a verified non-domain user', async () => {
    mockUser({ email: NON_DOMAIN_EMAIL, tags: [] });
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('fires the domain grant ADDITIVELY alongside the flat grant when the pending tag is present', async () => {
    mockUser({ email: DOMAIN_EMAIL, tags: [PENDING_FREE_CREDITS_TAG] });
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    // Both grants fire, each with its own stable transactionId (distinct -> additive).
    expect(flatGrantCall()?.[0]).toEqual(
      expect.objectContaining({ credits: 1000, transactionId: 'verify-grant:user-1' })
    );
    expect(domainGrantCall()?.[0]).toEqual(
      expect.objectContaining({ credits: EXPECTED_DOMAIN_CREDITS, transactionId: 'domain-grant-credits:user-1' })
    );
    // The pending tag is removed exactly once.
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1', tags: [] }));
  });

  it('grants the invite-resolved pendingCreditGrant amount instead of the setting', async () => {
    mockUser({ email: NON_DOMAIN_EMAIL, tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: 500 });
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(flatGrantCall()?.[0]).toEqual(
      expect.objectContaining({ credits: 500, transactionId: 'verify-grant:user-1' })
    );
    // The defaultFreeCredits setting is not consulted when a pending amount travels on the doc...
    expect(mockFindBySettingName).not.toHaveBeenCalled();
    // ...and the tag and the pending amount are cleared together.
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', tags: [], pendingCreditGrant: null })
    );
  });

  it('uses a stable idempotent transactionId so a re-verify cannot double-grant', async () => {
    mockUser({ email: DOMAIN_EMAIL, tags: [] });

    const first = makeReqRes();
    await handler(first.req, first.res);
    const second = makeReqRes();
    await handler(second.req, second.res);

    const ids = mockAddCredits.mock.calls.map(([p]) => p.transactionId);
    // Both invocations key on the same id - the addCredits transactionId gate
    // (proven in creditService/addCredits.test.ts) turns the second into a no-op.
    expect(ids).toEqual(['domain-grant-credits:user-1', 'domain-grant-credits:user-1']);
  });

  it('swallows a domain-grant failure and still returns verification success', async () => {
    mockUser({ email: DOMAIN_EMAIL, tags: [] });
    mockAddCredits.mockRejectedValueOnce(new Error('boom'));
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect((req as any).logger.error).toHaveBeenCalled();
  });

  // DB-backed partner rules (issue #293): a matched rule is the source of truth,
  // overriding the env registry for both the entitlement keys and the credit amount.
  it('grants the DB rule signupCredits (per-partner amount) over the env amount', async () => {
    // A domain the env registry does NOT confer (so env would grant 0) - proves the
    // DB rule is what fires, not a coincidental env match.
    mockUser({ email: 'person@newpartner.com', tags: [] });
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 150_000,
    });
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(domainGrantCall()?.[0]).toEqual(
      expect.objectContaining({ credits: 150_000, transactionId: 'domain-grant-credits:user-1' })
    );
  });

  it('honors a DB rule that grants access with 0 bonus credits (no env fallback)', async () => {
    // Even for an env-domain email, a matched rule with 0 credits must NOT fall back
    // to the env 250_000 - `matched` distinguishes "0 on purpose" from "no rule".
    mockUser({ email: DOMAIN_EMAIL, tags: [] });
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 0,
    });
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    // 0 credits -> no domain grant credit call at all, and definitely not the env 250k.
    expect(domainGrantCall()).toBeFalsy();
  });
});
