import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CreditHolderType, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { signupCreditsForEmail } from '@client/lib/entitlements/registry';

const { refreshSignupRiskScore } = vi.hoisted(() => ({ refreshSignupRiskScore: vi.fn(async () => undefined) }));
vi.mock('@server/auth/riskEvidence', () => ({ requestRiskEvidenceRefresh: vi.fn(async () => 'queued') }));
vi.mock('@server/auth/signupRiskScore', () => ({ refreshSignupRiskScore }));

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
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: any, _res: any, next: any) => next?.(),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
const mockEmitVerifiedFunnel = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/analytics/funnel', () => ({
  emitEmailVerifiedFunnelEvents: (...a: any[]) => mockEmitVerifiedFunnel(...a),
}));
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
const mockClearPending = vi.fn();
const mockFindBySettingName = vi.fn();
// Default: this inbox has not claimed its free-credit grant anywhere else, so the domain grant pays.
const mockClaimFreeCreditGrant = vi.fn(async (_userId: string) => true);
// Pulled in transitively by signupDomainGrant; these tests never reach a rule with a subscription.
vi.mock('@server/subscriptions/grantIndividualAdminSubscription', () => ({
  grantIndividualAdminSubscription: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findByEmailVerificationToken: (...a: any[]) => mockFindByToken(...a),
    update: (...a: any[]) => mockUpdate(...a),
    clearPendingFreeCreditGrant: (...a: any[]) => mockClearPending(...a),
    // The domain grant claims the one-grant-per-inbox entitlement before crediting; these tests
    // are about the handler, so the inbox is always free here.
    claimFreeCreditGrant: (...a: any[]) => mockClaimFreeCreditGrant(...a),
  },
  withTransaction: (fn: any) => fn(),
  adminSettingsRepository: { findBySettingName: (...a: any[]) => mockFindBySettingName(...a) },
  creditTransactionRepository: {},
  creditLotRepository: {},
}));

const mockVerifyEmailToken = vi.fn();
const mockAddCredits = vi.fn();
const mockReleasePending = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: {
    verifyEmailToken: (...a: unknown[]) => mockVerifyEmailToken(...a),
    releasePendingFreeCredits: (...a: unknown[]) => mockReleasePending(...a),
  },
  creditService: { addCredits: (...a: any[]) => mockAddCredits(...a) },
}));

import handler from '@pages/api/email/verify';

// Our own internal staff domain - a real DOMAIN_GRANT_ROWS entry conferring the
// single OptiHashi product tier, so the real registry sums to its signup credit total.
// (The former Q/Work tier was folded into optihashi:pro, so this is now a
// one-product grant, not two.)
const DOMAIN_EMAIL = 'staff@bike4mind.com';
const NON_DOMAIN_EMAIL = 'nobody@example.com';
// Pinned literal (not derived from the registry, which would make the assertions circular):
// the optihashi:pro grant pays 250,000. This path resolves the literal domain keys only (no
// implication expansion), so the implied questmaster:pro credit is not in play here - the
// implied-key de-dup is pinned in the registry test.
const EXPECTED_DOMAIN_CREDITS = 250_000;

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
// The flat-grant arithmetic (amount resolution, transactionId) is covered in
// userService/freeCredits.test.ts; this fake honours the same contract at the handler seam.
const FLAT_GRANT_AMOUNT = 1000;
function fakeReleasePending(user: { tags?: string[]; pendingCreditGrant?: number | null }) {
  if (!user.tags?.includes(PENDING_FREE_CREDITS_TAG)) {
    return { released: false, creditsGranted: 0, currentCredits: null, patch: {} };
  }
  return {
    released: true,
    creditsGranted: user.pendingCreditGrant ?? FLAT_GRANT_AMOUNT,
    currentCredits: null,
    patch: { tags: user.tags.filter(t => t !== PENDING_FREE_CREDITS_TAG), pendingCreditGrant: null },
  };
}
const flatGrantCall = () =>
  mockReleasePending.mock.calls.find(([user]) => user.tags?.includes(PENDING_FREE_CREDITS_TAG));

describe('/api/email/verify — domain-grant signup credits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyEmailToken.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
    mockClearPending.mockImplementation(async (id: string) => ({ id, tags: [] }));
    mockAddCredits.mockResolvedValue({});
    mockReleasePending.mockImplementation(async user => fakeReleasePending(user));
    mockFindBySettingName.mockResolvedValue({ settingValue: 1000 });
    mockPartnerGrant.mockResolvedValue({ matched: false, entitlements: new Set(), signupCredits: 0 });
  });

  it('is a sanity check that the fixture domain actually confers the product credit sum', () => {
    // Guards the rest of the suite: if bike4mind.com ever stops conferring the
    // product, these assertions would silently pass on 0 credits. Single-product
    // (optihashi:pro) since the Q/Work tier fold; was 500_000 (two products).
    expect(signupCreditsForEmail(DOMAIN_EMAIL, true)).toBe(EXPECTED_DOMAIN_CREDITS);
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
        credits: 250_000,
        type: 'generic_add',
        transactionId: 'domain-grant-credits:user-1',
      })
    );
    // No pending tag -> nothing is released: no tag-strip write, and only the domain grant
    // counts toward credits_granted.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEmitVerifiedFunnel).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'link', creditsGranted: EXPECTED_DOMAIN_CREDITS })
    );
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
    expect(flatGrantCall()).toBeTruthy();
    expect(domainGrantCall()?.[0]).toEqual(
      expect.objectContaining({ credits: EXPECTED_DOMAIN_CREDITS, transactionId: 'domain-grant-credits:user-1' })
    );
    // The pending tag is removed exactly once.
    expect(mockClearPending).toHaveBeenCalledOnce();
    expect(mockClearPending).toHaveBeenCalledWith('user-1');
  });

  it('grants the invite-resolved pendingCreditGrant amount instead of the setting', async () => {
    mockUser({ email: NON_DOMAIN_EMAIL, tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: 500 });
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    // The pending amount travels on the user doc into the service...
    expect(flatGrantCall()?.[0]).toEqual(expect.objectContaining({ id: 'user-1', pendingCreditGrant: 500 }));
    // ...and the tag and the pending amount are cleared together.
    expect(mockClearPending).toHaveBeenCalledWith('user-1');
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

describe('/api/email/verify - funnel events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyEmailToken.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
    mockClearPending.mockImplementation(async (id: string) => ({ id, tags: [] }));
    mockAddCredits.mockResolvedValue({});
    mockReleasePending.mockImplementation(async user => fakeReleasePending(user));
    mockFindBySettingName.mockResolvedValue({ settingValue: 1000 });
    mockPartnerGrant.mockResolvedValue({ matched: false, entitlements: new Set(), signupCredits: 0 });
  });

  it('reports the summed credits for both grants', async () => {
    mockUser({ email: DOMAIN_EMAIL, tags: [PENDING_FREE_CREDITS_TAG] });
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(mockEmitVerifiedFunnel).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'user-1' }),
      method: 'link',
      creditsGranted: 1000 + EXPECTED_DOMAIN_CREDITS,
    });
  });

  it('reports zero credits when nothing was granted', async () => {
    mockUser({ email: NON_DOMAIN_EMAIL, tags: [] });
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(mockEmitVerifiedFunnel).toHaveBeenCalledWith(expect.objectContaining({ method: 'link', creditsGranted: 0 }));
  });

  it('leaves a failed grant out of the reported credits', async () => {
    mockUser({ email: NON_DOMAIN_EMAIL, tags: [PENDING_FREE_CREDITS_TAG] });
    mockReleasePending.mockResolvedValue({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockEmitVerifiedFunnel).toHaveBeenCalledWith(expect.objectContaining({ creditsGranted: 0 }));
  });

  it('reports nothing when the token does not verify', async () => {
    mockUser({ email: NON_DOMAIN_EMAIL, tags: [] });
    mockVerifyEmailToken.mockRejectedValue(new Error('Token has expired'));
    const { req, res } = makeReqRes();

    await Promise.resolve(handler(req, res)).catch(() => {});

    expect(mockEmitVerifiedFunnel).not.toHaveBeenCalled();
  });
});
