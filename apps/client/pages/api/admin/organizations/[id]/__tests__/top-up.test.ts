import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

// Captures the config so a test can assert requiredScopes: the scope gate lives in
// apiKeyAuth (real middleware, not exercised here), so asserting the handler is
// registered with it is the only guard available at this level.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'POST']?.(req, res),
      {
        use: () => chain,
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

const mockAddCredits = vi.fn();
vi.mock('@bike4mind/services', () => ({
  creditService: {
    addCreditsWithLedgerRow: (...a: unknown[]) => mockAddCredits(...a),
    // The route distinguishes a replayed key from a real failure by type, so this has to be the
    // class the route reads, not a stand-in.
    DuplicateCreditTransactionError: class DuplicateCreditTransactionError extends Error {},
  },
}));

let inTransaction = false;
let insideTransactionAtAudit: boolean | undefined;
const mockOrgFindById = vi.fn();
const mockTxFindOne = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: { findOne: (...a: unknown[]) => mockTxFindOne(...a) },
  organizationRepository: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  withTransaction: async (fn: (session: unknown) => Promise<unknown>) => {
    inTransaction = true;
    try {
      return await fn(undefined);
    } finally {
      inTransaction = false;
    }
  },
}));

vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
// parseAdminActionReason stays real so the reason 400s come from the route itself.
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn(async () => {
    insideTransactionAtAudit = inTransaction;
    return null;
  }),
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { creditService } from '@bike4mind/services';
import { creditLotRepository, creditTransactionRepository, organizationRepository } from '@bike4mind/database';
import handler from '../top-up';

const BODY = { credits: 100, idempotencyKey: 'idem-key-12345', reason: 'Support goodwill top-up' };

function call(options: { isAdmin?: boolean; body?: object; id?: string }) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: options.id ?? 'org-1' },
    body: options.body ?? BODY,
  });
  (req as unknown as { user: { isAdmin: boolean; id: string; username: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
    username: 'admin',
  };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('POST /api/admin/organizations/[id]/top-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindById.mockResolvedValue({ id: 'org-1', userId: 'owner-1' });
    mockAddCredits.mockResolvedValue({ creditHolder: {}, creditTransactionId: 'tx-topup' });
    mockTxFindOne.mockResolvedValue(null);
  });

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    // Pins the whole config object, not just requiredScopes - a sibling `auth: false`
    // would skip baseApi's entire api-key chain (baseApi.ts's `if (resolvedOptions.auth)`)
    // and disable this gate while leaving requiredScopes untouched.
    const config = (handler as unknown as { _config?: unknown })._config;
    expect(config).toEqual({ requiredScopes: [ApiKeyScope.ADMIN] });
  });

  it('rejects a non-admin', async () => {
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('grants credits to the organization for an admin', async () => {
    const { res, run } = call({});
    await run();
    expect(mockAddCredits).toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({ organizationId: 'org-1', creditsAdded: 100 });
  });

  it('records org.credits.topped_up against the organization, inside the transaction', async () => {
    const { run } = call({});
    await run();
    expect(insideTransactionAtAudit).toBe(true);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.credits.topped_up',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1' }),
        reason: 'Support goodwill top-up',
        related: { creditTransactionId: 'tx-topup' },
      })
    );
  });

  it('omits related when the ledger write reports no row (idempotent retry)', async () => {
    mockAddCredits.mockResolvedValue({ creditHolder: {}, creditTransactionId: undefined });
    const { run } = call({});
    await run();
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ related: undefined })
    );
  });

  it('fails the request when the strict audit write fails, so the transaction rolls back', async () => {
    vi.mocked(recordAdminActionFromRequest).mockRejectedValueOnce(new Error('audit down'));
    const { res, run } = call({});
    await expect(run()).rejects.toThrow('audit down');
    expect(res._isEndCalled()).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['under five characters', ' abc '],
    ['over 500 characters', 'x'.repeat(501)],
  ])('answers 400 and adds no credits when the reason is %s', async (_label, reason) => {
    const { run } = call({ body: { ...BODY, reason } });
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/organizations/[id]/top-up credit kind', () => {
  const body = { credits: 100, idempotencyKey: 'idem-key-12345', reason: 'Support goodwill top-up' };
  const dedupeKey = 'admin_topup_org-1_idem-key-12345';
  const refundKey = 'admin_refund_org-1_idem-key-12345';

  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindById.mockResolvedValue({ id: 'org-1', userId: 'owner-1', name: 'Org One' });
    mockAddCredits.mockResolvedValue({ creditHolder: {}, creditTransactionId: undefined });
    mockTxFindOne.mockResolvedValue(null);
  });

  it('defaults to a subscription grant, unchanged', async () => {
    const { res, run } = call({ body });
    await run();
    expect(mockAddCredits).toHaveBeenCalledTimes(1);
    expect(mockAddCredits.mock.calls[0][0]).toEqual({
      ownerId: 'org-1',
      ownerType: 'Organization',
      credits: 100,
      type: 'subscription',
      stripePaymentIntentId: dedupeKey,
      metadata: { adminUserId: 'admin-1', reason: 'Support goodwill top-up', source: 'admin_topup' },
    });
    expect(mockTxFindOne).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.credits.topped_up',
        summary: 'topped up 100 credits',
        details: { credits: 100, ownerId: 'owner-1' },
      })
    );
    expect(res._getJSONData()).toEqual({ organizationId: 'org-1', creditsAdded: 100 });
  });

  it('treats an explicit top_up like the default', async () => {
    const { run } = call({ body: { ...body, kind: 'top_up' } });
    await run();
    expect(mockAddCredits.mock.calls[0][0]).toMatchObject({ type: 'subscription', stripePaymentIntentId: dedupeKey });
  });

  it('keeps the free-text reason as the audit note, not the refund switch', async () => {
    const { run } = call({ body: { ...body, reason: 'refund' } });
    await run();
    expect(mockAddCredits.mock.calls[0][0]).toMatchObject({
      type: 'subscription',
      metadata: { reason: 'refund', source: 'admin_topup' },
    });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'refund' })
    );
  });

  it('writes a refund as generic_add with reason refund to the organization, keyed on the idempotency key', async () => {
    const { res, run } = call({ body: { ...body, kind: 'refund', reason: 'invoice dispute' } });
    await run();
    expect(mockAddCredits).toHaveBeenCalledTimes(1);
    const [params, adapters] = mockAddCredits.mock.calls[0];
    expect(params).toEqual({
      ownerId: 'org-1',
      ownerType: 'Organization',
      credits: 100,
      type: 'generic_add',
      reason: 'refund',
      description: 'Admin refund',
      transactionId: refundKey,
      metadata: { adminUserId: 'admin-1', reason: 'invoice dispute', source: 'admin_refund' },
    });
    expect(adapters.creditHolderMethods).toBe(organizationRepository);
    expect(adapters.db).toEqual({ creditTransactions: creditTransactionRepository, creditLots: creditLotRepository });
    // A refund must not re-read the aborted session after the swallowed duplicate.
    expect(adapters.duplicateTransactionId).toBe('throw');
    expect(res._getJSONData()).toEqual({ organizationId: 'org-1', creditsAdded: 100 });
  });

  it('audits a refund as its own action inside the same transaction as the credit write', async () => {
    insideTransactionAtAudit = undefined;
    const { run } = call({ body: { ...body, kind: 'refund', reason: 'invoice dispute' } });
    await run();
    expect(insideTransactionAtAudit).toBe(true);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.credits.refunded',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1' }),
        summary: 'refunded 100 credits',
        reason: 'invoice dispute',
        details: { credits: 100, ownerId: 'owner-1', kind: 'refund' },
      })
    );
  });

  it('answers 400 for a refund with no reason, before any lookup or credit write', async () => {
    const { reason: _omitted, ...noReason } = body;
    const { run } = call({ body: { ...noReason, kind: 'refund' } });
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockTxFindOne).not.toHaveBeenCalled();
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('keys a refund apart from a top-up submitted with the same idempotency key', async () => {
    // They dedupe on different fields, so a shared key would be caught by neither index.
    await call({ body }).run();
    await call({ body: { ...body, kind: 'refund' } }).run();
    expect(mockAddCredits.mock.calls[0][0].stripePaymentIntentId).toBe(dedupeKey);
    expect(mockAddCredits.mock.calls[1][0].transactionId).toBe(refundKey);
  });

  it('answers a replayed refund as idempotent without crediting or auditing twice', async () => {
    mockTxFindOne.mockResolvedValue({ id: 'tx-1' });
    const { res, run } = call({ body: { ...body, kind: 'refund' } });
    await run();
    expect(mockTxFindOne).toHaveBeenCalledWith({ transactionId: refundKey });
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({ organizationId: 'org-1', creditsAdded: 100, idempotent: true });
  });

  it('answers a refund that lost a concurrent race idempotently instead of failing the request', async () => {
    mockAddCredits.mockRejectedValue(new creditService.DuplicateCreditTransactionError());
    const { res, run } = call({ body: { ...body, kind: 'refund' } });
    await run();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ organizationId: 'org-1', creditsAdded: 100, idempotent: true });
  });

  it('rethrows a refund failure that is not a duplicate', async () => {
    const boom = new Error('boom');
    mockAddCredits.mockRejectedValue(boom);
    const { res, run } = call({ body: { ...body, kind: 'refund' } });
    await expect(run()).rejects.toBe(boom);
    expect(res._isEndCalled()).toBe(false);
  });

  it('does not look for a winning row when a non-refund top-up fails with a non-11000 error', async () => {
    mockAddCredits.mockRejectedValue(new Error('boom'));
    const { run } = call({ body });
    await expect(run()).rejects.toThrow('boom');
    expect(mockTxFindOne).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind before touching credits', async () => {
    const { run } = call({ body: { ...body, kind: 'gift' } });
    await expect(run()).rejects.toThrow();
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('still rejects a non-admin on the refund path', async () => {
    const { run } = call({ isAdmin: false, body: { ...body, kind: 'refund' } });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockAddCredits).not.toHaveBeenCalled();
  });
});
