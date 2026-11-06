import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET/PUT /api/organizations/[id] are access-gated to org members already; this test
 * pins the response SCOPING: stripeCustomerId is dropped for everyone and
 * billingContact only survives for the owner/admin. In-org fields (systemPrompt,
 * userDetails) are preserved so member UIs keep working. The PUT (update) response
 * is routed through the same serializer so a manager updating org settings never
 * gets billing identifiers echoed back.
 *
 * The real protection against body-override of the org id is that updateOrgBodySchema
 * is a plain z.object() with no .passthrough(): Zod strips any id field from
 * req.body before the spread. The 'URL id wins' test documents that intent;
 * the BadRequestError test is load-bearing.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  putHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

const get = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 'org1',
    userId: 'owner1',
    name: 'Acme',
    systemPrompt: 'ctx',
    billingContact: 'billing@acme.com',
    stripeCustomerId: 'cus_SECRET',
    userDetails: [{ id: 'owner1', email: 'o@acme.com', name: 'O', usedCredits: 1, lastCreditUsedAt: null }],
  }))
);
const update = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 'org1',
    userId: 'owner1',
    name: 'Acme',
    systemPrompt: 'ctx',
    billingContact: 'billing@acme.com',
    stripeCustomerId: 'cus_SECRET',
  }))
);
const credits = vi.hoisted(() => ({
  findById: vi.fn(async () => ({ id: 'org1', name: 'Acme', userId: 'owner1', currentCredits: 100 })),
  addCreditsWithLedgerRow: vi.fn(async () => ({ creditHolder: {}, creditTransactionId: 'tx-add' })),
  subtractCreditsWithLedgerRow: vi.fn(async () => ({ creditHolder: {}, creditTransactionId: 'tx-sub' })),
  recordAdminAction: vi.fn(async () => null),
  withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
}));
vi.mock('@bike4mind/services', () => ({
  organizationService: { get, update },
  creditService: {
    addCreditsWithLedgerRow: credits.addCreditsWithLedgerRow,
    subtractCreditsWithLedgerRow: credits.subtractCreditsWithLedgerRow,
  },
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById: credits.findById } }));
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  integrationRequestRepository: {},
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  lakeConfigChangeEventRepository: {},
  adminSettingsRepository: {},
  partnerSignupRuleRepository: {},
  userRepository: {},
  withTransaction: credits.withTransaction,
}));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@server/entitlements/partnerRules', () => ({ invalidatePartnerRuleCache: vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({
  parseAdminActionReason: (value: unknown) => String(value),
  recordAdminActionFromRequest: credits.recordAdminAction,
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({ subscriptionRepository: {} }));
vi.mock('@bike4mind/server-utils/lib/subscriptions/types', () => ({
  SubscriptionOwnerType: { Organization: 'organization' },
}));

import '@pages/api/organizations/[id]/index';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

function mocks(user: unknown, method: 'GET' | 'PUT' = 'GET') {
  const { req, res } = createMocks({ method, query: { id: 'org1' } });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/organizations/[id] - safe serialization', () => {
  beforeEach(() => get.mockClear());

  it('drops billing identifiers for a non-owner, non-admin member but keeps in-org fields', async () => {
    const { req, res } = mocks({ id: 'member2', isAdmin: false });
    await mockRefs.getHandler!(req, res);
    const body = res._getJSONData();
    expect('stripeCustomerId' in body).toBe(false);
    expect('billingContact' in body).toBe(false);
    expect(body.systemPrompt).toBe('ctx');
    expect(Array.isArray(body.userDetails)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });

  it('keeps billingContact for the owner (but never stripeCustomerId)', async () => {
    const { req, res } = mocks({ id: 'owner1', isAdmin: false });
    await mockRefs.getHandler!(req, res);
    const body = res._getJSONData();
    expect(body.billingContact).toBe('billing@acme.com');
    expect('stripeCustomerId' in body).toBe(false);
  });
});

describe('PUT /api/organizations/[id] - URL id wins', () => {
  beforeEach(() => update.mockClear());

  it('takes the org id from the URL, not from any id field in the body', async () => {
    const { req, res } = mocks({ id: 'caller', isAdmin: true }, 'PUT');
    (req as any).body = { id: 'from-body', name: 'renamed' };
    await mockRefs.putHandler!(req, res);
    const [, params] = update.mock.calls[0];
    expect(params.id).toBe('org1');
    expect(params.name).toBe('renamed');
  });

  it('forwards storageLimit (including a fractional MB and null) instead of stripping it', async () => {
    for (const storageLimit of [0.5, null]) {
      update.mockClear();
      const { req, res } = mocks({ id: 'caller', isAdmin: true }, 'PUT');
      (req as any).body = { storageLimit };
      await mockRefs.putHandler!(req, res);
      const [, params] = update.mock.calls[0];
      expect(params.storageLimit).toBe(storageLimit);
    }
  });

  it.each([-5, 1e303])('rejects an out-of-range storageLimit (%d) before reaching the service', async storageLimit => {
    update.mockClear();
    const { req, res } = mocks({ id: 'caller', isAdmin: true }, 'PUT');
    (req as any).body = { storageLimit };
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a missing id with BadRequestError before reaching the service', async () => {
    const { req, res } = createMocks({ method: 'PUT', query: {} });
    (req as any).user = { id: 'caller', isAdmin: true };
    await expect(mockRefs.putHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PUT /api/organizations/[id] - safe serialization', () => {
  beforeEach(() => update.mockClear());

  it('drops billing identifiers when a manager (non-owner, non-admin) updates', async () => {
    const { req, res } = mocks({ id: 'manager2', isAdmin: false }, 'PUT');
    await mockRefs.putHandler!(req, res);
    const body = res._getJSONData();
    expect('stripeCustomerId' in body).toBe(false);
    expect('billingContact' in body).toBe(false);
    expect(body.systemPrompt).toBe('ctx');
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });

  it('keeps billingContact for the owner (but never stripeCustomerId)', async () => {
    const { req, res } = mocks({ id: 'owner1', isAdmin: false }, 'PUT');
    await mockRefs.putHandler!(req, res);
    const body = res._getJSONData();
    expect(body.billingContact).toBe('billing@acme.com');
    expect('stripeCustomerId' in body).toBe(false);
  });
});

describe('PUT /api/organizations/[id] - admin credit edit', () => {
  beforeEach(() => {
    update.mockClear();
    Object.values(credits).forEach(fn => fn.mockClear());
  });

  function putAsAdmin(body: Record<string, unknown>) {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true }, 'PUT');
    (req as any).body = body;
    return { req, res };
  }

  it('runs the credit edit and the profile update in one transaction', async () => {
    const { req, res } = putAsAdmin({ name: 'renamed', currentCredits: 150, creditReason: 'goodwill grant' });
    await mockRefs.putHandler!(req, res);
    expect(credits.withTransaction).toHaveBeenCalledTimes(1);
    expect(credits.addCreditsWithLedgerRow).toHaveBeenCalledTimes(1);
    expect(credits.recordAdminAction).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('links the credit audit entry to the ledger row it wrote', async () => {
    const { req, res } = putAsAdmin({ currentCredits: 150, creditReason: 'goodwill grant' });
    await mockRefs.putHandler!(req, res);
    expect(credits.recordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'org.credits.adjusted', related: { creditTransactionId: 'tx-add' } })
    );
  });

  it('propagates a failing profile update out of the transaction after the credit edit', async () => {
    update.mockRejectedValueOnce(new Error('profile write failed'));
    const { req, res } = putAsAdmin({ name: 'renamed', currentCredits: 150, creditReason: 'goodwill grant' });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow('profile write failed');
    expect(credits.addCreditsWithLedgerRow).toHaveBeenCalledTimes(1);
    expect(credits.withTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not open a transaction when no credit value is sent', async () => {
    const { req, res } = putAsAdmin({ name: 'renamed' });
    await mockRefs.putHandler!(req, res);
    expect(credits.withTransaction).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([null, '', '  ', '1,000'])('rejects currentCredits %j and writes nothing', async currentCredits => {
    const { req, res } = putAsAdmin({ currentCredits, creditReason: 'goodwill grant' });
    await expect(mockRefs.putHandler!(req, res)).rejects.toMatchObject({ name: 'ZodError' });
    expect(credits.withTransaction).not.toHaveBeenCalled();
    expect(credits.addCreditsWithLedgerRow).not.toHaveBeenCalled();
    expect(credits.subtractCreditsWithLedgerRow).not.toHaveBeenCalled();
    expect(credits.recordAdminAction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a negative balance and writes nothing', async () => {
    const { req, res } = putAsAdmin({ currentCredits: -5, creditReason: 'goodwill grant' });
    await expect(mockRefs.putHandler!(req, res)).rejects.toMatchObject({ name: 'ZodError' });
    expect(credits.withTransaction).not.toHaveBeenCalled();
    expect(credits.addCreditsWithLedgerRow).not.toHaveBeenCalled();
    expect(credits.subtractCreditsWithLedgerRow).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
