import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

const update = vi.hoisted(() => vi.fn(async () => ({ id: 'org1', userId: 'u1', name: 'Acme' })));
const credit = vi.hoisted(() => ({
  findById: vi.fn(),
  addCredits: vi.fn(),
  subtractCredits: vi.fn(),
  recordAdminActionFromRequest: vi.fn(),
  parseAdminActionReason: vi.fn((value: unknown) => {
    if (typeof value !== 'string' || value.trim().length < 5) throw new Error('reason required');
    return value.trim();
  }),
}));
vi.mock('@bike4mind/services', () => ({
  organizationService: { update, get: vi.fn() },
  creditService: { addCredits: credit.addCredits, subtractCredits: credit.subtractCredits },
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById: credit.findById } }));
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  partnerSignupRuleRepository: {},
  userRepository: {},
  withTransaction: (fn: any) => fn(),
}));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  toSafeOrganization: (org: any) => org,
}));
vi.mock('@server/utils/adminAudit', () => ({
  parseAdminActionReason: credit.parseAdminActionReason,
  recordAdminActionFromRequest: credit.recordAdminActionFromRequest,
}));
vi.mock('@server/entitlements/partnerRules', () => ({ invalidatePartnerRuleCache: vi.fn() }));
vi.mock('@server/models/Subscription', () => ({ subscriptionRepository: {} }));
vi.mock('@client/lib/subscriptions/types', () => ({ SubscriptionOwnerType: {} }));

import '@pages/api/organizations/[id]/index';

function makeReq(body: unknown, queryId = 'org-123', isAdmin = false) {
  const { req, res } = createMocks({ method: 'PUT', query: { id: queryId } });
  (req as any).user = { id: 'u1', isAdmin };
  (req as any).ability = null;
  (req as any).body = body;
  return { req, res };
}

describe('PUT /api/organizations/[id] -- Zod validation', () => {
  beforeEach(() => update.mockClear());

  it('accepts a real client payload (name + description)', async () => {
    const { req, res } = makeReq({ name: 'Acme Corp', description: 'We build things' });
    await mockRefs.putHandler!(req, res);
    expect(update).toHaveBeenCalledOnce();
  });

  it('accepts systemPrompt up to 10000 chars', async () => {
    const { req, res } = makeReq({ systemPrompt: 'a'.repeat(100) });
    await mockRefs.putHandler!(req, res);
    expect(update).toHaveBeenCalledOnce();
  });

  it('rejects systemPrompt over 10000 chars', async () => {
    const { req, res } = makeReq({ systemPrompt: 'a'.repeat(10001) });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(ZodError);
    expect(update).not.toHaveBeenCalled();
  });

  it('ignores currentCredits from a non-admin and never passes it to the service', async () => {
    const { req, res } = makeReq({ currentCredits: '500' });
    await mockRefs.putHandler!(req, res);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][1]).not.toHaveProperty('currentCredits');
    expect(credit.findById).not.toHaveBeenCalled();
  });

  it('rejects non-numeric currentCredits that coerce to NaN', async () => {
    const { req, res } = makeReq({ currentCredits: 'not-a-number' });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(ZodError);
    expect(update).not.toHaveBeenCalled();
  });

  it('strips unknown keys before they reach the service', async () => {
    const { req, res } = makeReq({ name: 'n', stripeCustomerId: 'cus_EVIL' });
    await mockRefs.putHandler!(req, res);
    const calledBody = update.mock.calls[0][1] as any;
    expect(calledBody).not.toHaveProperty('stripeCustomerId');
  });
});

describe('PUT /api/organizations/[id] -- admin credit edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credit.findById.mockResolvedValue({ id: 'org-123', userId: 'owner-1', name: 'Acme', currentCredits: 1000 });
  });

  it('books a raised balance to the ledger and records a signed audit entry', async () => {
    const { req, res } = makeReq({ currentCredits: '1500', creditReason: 'Goodwill for the outage' }, 'org-123', true);
    await mockRefs.putHandler!(req, res);

    expect(credit.addCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'org-123',
        ownerType: 'Organization',
        credits: 500,
        type: 'generic_add',
        reason: 'admin_adjustment',
      }),
      expect.anything()
    );
    expect(credit.recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.credits.adjusted',
        reason: 'Goodwill for the outage',
        details: expect.objectContaining({ credits: 500 }),
        changes: [{ field: 'currentCredits', before: 1000, after: 1500 }],
      })
    );
    expect(update.mock.calls[0][1]).not.toHaveProperty('currentCredits');
  });

  it('books a lowered balance as a deduction with a negative stamp', async () => {
    const { req, res } = makeReq({ currentCredits: 800, creditReason: 'Reverse a duplicate grant' }, 'org-123', true);
    await mockRefs.putHandler!(req, res);

    expect(credit.subtractCredits).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 200, type: 'generic_deduct' }),
      expect.anything()
    );
    expect(credit.recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ details: expect.objectContaining({ credits: -200 }) })
    );
  });

  it('refuses a balance change without a reason and moves nothing', async () => {
    const { req, res } = makeReq({ currentCredits: 1500 }, 'org-123', true);
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow('reason required');

    expect(credit.addCredits).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('treats an unchanged balance as a profile-only save with no reason needed', async () => {
    const { req, res } = makeReq({ name: 'Acme', currentCredits: 1000 }, 'org-123', true);
    await mockRefs.putHandler!(req, res);

    expect(credit.addCredits).not.toHaveBeenCalled();
    expect(credit.subtractCredits).not.toHaveBeenCalled();
    expect(credit.recordAdminActionFromRequest).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });
});
