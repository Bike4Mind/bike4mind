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
  events: [] as string[],
  findById: vi.fn(),
  addCreditsWithLedgerRow: vi.fn(),
  subtractCreditsWithLedgerRow: vi.fn(),
  recordAdminActionFromRequest: vi.fn(),
  parseAdminActionReason: vi.fn((value: unknown) => {
    if (typeof value !== 'string' || value.trim().length < 5) throw new Error('reason required');
    return value.trim();
  }),
}));
vi.mock('@bike4mind/services', () => ({
  organizationService: { update, get: vi.fn() },
  creditService: {
    addCreditsWithLedgerRow: credit.addCreditsWithLedgerRow,
    subtractCreditsWithLedgerRow: credit.subtractCreditsWithLedgerRow,
  },
}));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: {
    findById: (...a: unknown[]) => {
      credit.events.push('findById');
      return credit.findById(...a);
    },
  },
}));
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  partnerSignupRuleRepository: {},
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  lakeConfigChangeEventRepository: {},
  adminSettingsRepository: {},
  userRepository: {},
  withTransaction: async (fn: any) => {
    credit.events.push('tx:start');
    const result = await fn();
    credit.events.push('tx:end');
    return result;
  },
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
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({ subscriptionRepository: {} }));
vi.mock('@bike4mind/server-utils/lib/subscriptions/types', () => ({ SubscriptionOwnerType: {} }));

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
    credit.events.length = 0;
    credit.findById.mockResolvedValue({ id: 'org-123', userId: 'owner-1', name: 'Acme', currentCredits: 1000 });
    credit.addCreditsWithLedgerRow.mockImplementation(async () => {
      credit.events.push('addCreditsWithLedgerRow');
      return { creditHolder: {}, creditTransactionId: 'tx-add' };
    });
    credit.subtractCreditsWithLedgerRow.mockImplementation(async () => {
      credit.events.push('subtractCreditsWithLedgerRow');
      return { creditHolder: {}, creditTransactionId: 'tx-sub' };
    });
    credit.recordAdminActionFromRequest.mockImplementation(async () => {
      credit.events.push('record');
      return null;
    });
    update.mockImplementation(async () => {
      credit.events.push('update');
      return { id: 'org1', userId: 'u1', name: 'Acme' };
    });
  });

  it('books a raised balance to the ledger and records a signed audit entry', async () => {
    const { req, res } = makeReq({ currentCredits: '1500', creditReason: 'Goodwill for the outage' }, 'org-123', true);
    await mockRefs.putHandler!(req, res);

    expect(credit.addCreditsWithLedgerRow).toHaveBeenCalledWith(
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
        related: { creditTransactionId: 'tx-add' },
      })
    );
    expect(update.mock.calls[0][1]).not.toHaveProperty('currentCredits');
  });

  it('books a lowered balance as a deduction with a negative stamp', async () => {
    const { req, res } = makeReq({ currentCredits: 800, creditReason: 'Reverse a duplicate grant' }, 'org-123', true);
    await mockRefs.putHandler!(req, res);

    expect(credit.subtractCreditsWithLedgerRow).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 200, type: 'generic_deduct' }),
      expect.anything()
    );
    expect(credit.recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        details: expect.objectContaining({ credits: -200 }),
        related: { creditTransactionId: 'tx-sub' },
      })
    );
    expect(credit.events).toEqual([
      'tx:start',
      'findById',
      'subtractCreditsWithLedgerRow',
      'record',
      'update',
      'tx:end',
    ]);
  });

  it('reads the balance inside the transaction so a retry recomputes the delta', async () => {
    const { req, res } = makeReq({ currentCredits: 1500, creditReason: 'Goodwill for the outage' }, 'org-123', true);
    await mockRefs.putHandler!(req, res);

    expect(credit.events).toEqual(['tx:start', 'findById', 'addCreditsWithLedgerRow', 'record', 'update', 'tx:end']);
  });

  it('refuses a balance change without a reason and moves nothing', async () => {
    const { req, res } = makeReq({ currentCredits: 1500 }, 'org-123', true);
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow('reason required');

    expect(credit.addCreditsWithLedgerRow).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('treats an unchanged balance as a profile-only save with no reason needed', async () => {
    const { req, res } = makeReq({ name: 'Acme', currentCredits: 1000 }, 'org-123', true);
    await mockRefs.putHandler!(req, res);

    expect(credit.addCreditsWithLedgerRow).not.toHaveBeenCalled();
    expect(credit.subtractCreditsWithLedgerRow).not.toHaveBeenCalled();
    expect(credit.recordAdminActionFromRequest).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });
});
