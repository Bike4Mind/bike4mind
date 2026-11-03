import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, STRIPE_DISPUTE_LIST_LIMIT, type StripeDisputeItem } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Record<string, (req: unknown, res: unknown) => Promise<void>>>,
  current: '',
  routeOptions: vi.fn(),
  optionsByRoute: {} as Record<string, unknown>,
  list: vi.fn(),
  resolveByAdmin: vi.fn(),
  findById: vi.fn(),
  undoDisputeContain: vi.fn(),
  record: vi.fn(),
  userWrite: vi.fn(),
  DisputeContainUndoRefused: class extends Error {
    constructor(readonly result: { status: string; item?: unknown }) {
      super('refused');
    }
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
// The permission gate itself is adminApi's (covered by its own tests); these assert each route declares it.
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.routeOptions(options);
    h.optionsByRoute[h.current] = options;
    const route = (h.handlers[h.current] = {} as Record<string, (req: unknown, res: unknown) => Promise<void>>);
    const chain = {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => Promise<void>) => {
        route.get = fn;
        return chain;
      },
      post: (fn: (req: unknown, res: unknown) => Promise<void>) => {
        route.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  stripeDisputeRepository: { list: h.list, resolveByAdmin: h.resolveByAdmin, findById: h.findById },
  // Resolving only closes the record: any account write here fails the test.
  userRepository: { update: h.userWrite, updateOne: h.userWrite },
}));
// Mocked whole: the real module pulls in the users bulk graph, which these route tests do not need.
vi.mock('@server/billing/stripeDisputes', () => ({
  disputeAuditDetails: (item: StripeDisputeItem) => ({
    stripeDisputeId: item.stripeDisputeId,
    outcome: item.resolution?.outcome ?? null,
  }),
  undoDisputeContain: h.undoDisputeContain,
  DisputeContainUndoRefused: h.DisputeContainUndoRefused,
}));
vi.mock('@server/admin/usersBulk/adapters', () => ({ usersBulkUndoDeps: () => ({}) }));
vi.mock('@server/admin/usersBulk/undo', () => ({ SUPERSEDED_MESSAGE: 'Changed by a later bulk action' }));
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.record,
}));

const loadRoutes = async () => {
  h.current = 'list';
  await import('@pages/api/admin/stripe-disputes/index');
  h.current = 'resolve';
  await import('@pages/api/admin/stripe-disputes/resolve');
  h.current = 'undo';
  await import('@pages/api/admin/stripe-disputes/undo-contain');
};

const ADMIN_ID = 'a'.repeat(24);
const DISPUTE_ID = 'b'.repeat(24);
const REASON = 'Handled in Stripe with the billing contact';

const request = (method: 'GET' | 'POST', options: { body?: unknown; query?: Record<string, string> } = {}) => {
  const { req, res } = createMocks({ method, body: options.body, query: options.query });
  Object.assign(req, { user: { id: ADMIN_ID, isAdmin: true }, logger: { error: vi.fn() } });
  return { req, res };
};

// Stripe fixture values only.
const item = (overrides: Partial<StripeDisputeItem> = {}): StripeDisputeItem => ({
  id: DISPUTE_ID,
  stripeDisputeId: 'dp_test_1',
  chargeId: 'ch_test_1',
  paymentIntentId: null,
  amount: 4900,
  currency: 'usd',
  reason: 'fraudulent',
  stripeStatus: 'needs_response',
  subject: 'organization',
  subjectId: 'c'.repeat(24),
  state: 'open',
  openedAt: new Date('2026-10-01T00:00:00Z'),
  closedAt: null,
  resolution: null,
  contain: null,
  ...overrides,
});

// ms. Importing three routes cold is slow on a loaded runner; once per file, not per test.
const ROUTE_IMPORT_TIMEOUT_MS = 120_000;
beforeAll(loadRoutes, ROUTE_IMPORT_TIMEOUT_MS);

beforeEach(() => {
  h.list.mockReset().mockResolvedValue({ data: [], truncated: false });
  h.resolveByAdmin.mockReset();
  h.findById.mockReset();
  h.undoDisputeContain.mockReset();
  h.record.mockReset().mockResolvedValue(null);
  h.userWrite.mockReset();
});

describe('GET /api/admin/stripe-disputes', () => {
  it('is session-only and gated on the support read permission', () => {
    expect(h.routeOptions).toHaveBeenCalledWith({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'support:read' },
    });
  });

  it('passes the filters through and returns the list', async () => {
    h.list.mockResolvedValue({ data: [item()], truncated: true });
    const { req, res } = request('GET', { query: { state: 'open', subject: 'unmatched' } });

    await h.handlers.list.get(req, res);

    expect(h.list).toHaveBeenCalledWith({ state: 'open', subject: 'unmatched', limit: STRIPE_DISPUTE_LIST_LIMIT });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ truncated: true, data: [{ stripeDisputeId: 'dp_test_1' }] });
  });

  it('rejects an unknown filter', async () => {
    const { req, res } = request('GET', { query: { subject: 'everyone' } });
    await expect(h.handlers.list.get(req, res)).rejects.toThrow('Unknown state or subject filter');
  });
});

describe('POST /api/admin/stripe-disputes/resolve', () => {
  it('is gated on the moderation permission', () => {
    expect(h.optionsByRoute.resolve).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { POST: 'users:moderate' },
    });
  });

  it('resolves with the admin note and audits it, without touching any account', async () => {
    const resolved = item({
      state: 'resolved',
      resolution: { outcome: 'admin', resolvedBy: ADMIN_ID, note: REASON, resolvedAt: new Date() },
    });
    h.resolveByAdmin.mockResolvedValue({ status: 'updated', item: resolved });
    const { req, res } = request('POST', { body: { id: DISPUTE_ID, reason: REASON } });

    await h.handlers.resolve.post(req, res);

    expect(h.resolveByAdmin).toHaveBeenCalledWith({ id: DISPUTE_ID, adminId: ADMIN_ID, note: REASON });
    expect(res._getStatusCode()).toBe(200);
    expect(h.record).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'billing.dispute.resolved',
        reason: REASON,
        details: expect.objectContaining({ stripeDisputeId: 'dp_test_1', outcome: 'admin' }),
      })
    );
    expect(h.userWrite).not.toHaveBeenCalled();
  });

  it('still answers 200 when the audit write fails after the resolution committed', async () => {
    h.resolveByAdmin.mockResolvedValue({ status: 'updated', item: item({ state: 'resolved' }) });
    h.record.mockRejectedValue(new Error('audit down'));
    const { req, res } = request('POST', { body: { id: DISPUTE_ID, reason: REASON } });

    await h.handlers.resolve.post(req, res);

    expect(res._getStatusCode()).toBe(200);
  });

  it('answers 409 with the current record when the dispute is not resolvable', async () => {
    h.resolveByAdmin.mockResolvedValue({ status: 'conflict', item: item({ subject: 'user' }) });
    const { req, res } = request('POST', { body: { id: DISPUTE_ID, reason: REASON } });

    await h.handlers.resolve.post(req, res);

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ item: { subject: 'user' } });
    expect(h.record).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown dispute', async () => {
    h.resolveByAdmin.mockResolvedValue({ status: 'not_found' });
    const { req, res } = request('POST', { body: { id: DISPUTE_ID, reason: REASON } });
    await expect(h.handlers.resolve.post(req, res)).rejects.toThrow('Dispute not found');
  });

  it('requires a reason', async () => {
    const { req, res } = request('POST', { body: { id: DISPUTE_ID, reason: 'no' } });
    await expect(h.handlers.resolve.post(req, res)).rejects.toThrow();
    expect(h.resolveByAdmin).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/stripe-disputes/undo-contain', () => {
  const contained = () =>
    item({
      subject: 'user',
      state: 'resolved',
      contain: {
        batchId: 'stripe-dispute:dp_test_1',
        containedAt: new Date(),
        suspended: true,
        creditDelta: -500,
        apiKeysRevoked: 1,
        undoneAt: null,
        undoneBy: null,
      },
    });

  it('is session-only and gated on the moderation permission', () => {
    expect(h.optionsByRoute.undo).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { POST: 'users:moderate' },
    });
  });

  it('answers 409 when a later bulk action changed the user', async () => {
    h.findById.mockResolvedValue({ ...contained(), containSnapshot: { userId: 'u1', banned: true } });
    h.undoDisputeContain.mockRejectedValue(new Error('Changed by a later bulk action'));
    const { req, res } = request('POST', { body: { id: DISPUTE_ID, reason: REASON } });
    await expect(h.handlers.undo.post(req, res)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('answers 404 when the undo finds no dispute', async () => {
    h.findById.mockResolvedValue({ ...contained(), containSnapshot: null });
    h.undoDisputeContain.mockRejectedValue(new h.DisputeContainUndoRefused({ status: 'not_found' }));
    const { req, res } = request('POST', { body: { id: DISPUTE_ID, reason: REASON } });
    await expect(h.handlers.undo.post(req, res)).rejects.toThrow('Dispute not found');
  });

  it('rejects a bad body or a short reason before looking the dispute up', async () => {
    const bad = request('POST', { body: { id: 'nope', reason: REASON } });
    await expect(h.handlers.undo.post(bad.req, bad.res)).rejects.toThrow('Expected a dispute id and a reason');
    const short = request('POST', { body: { id: DISPUTE_ID, reason: 'no' } });
    await expect(h.handlers.undo.post(short.req, short.res)).rejects.toThrow();
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('undoes the Contain as the requesting admin', async () => {
    const dispute = { ...contained(), containSnapshot: { userId: 'u1', banned: true } };
    h.findById.mockResolvedValue(dispute);
    h.undoDisputeContain.mockResolvedValue({ ...dispute, contain: { ...dispute.contain, undoneAt: new Date() } });
    const { req, res } = request('POST', { body: { id: DISPUTE_ID, reason: REASON } });

    await h.handlers.undo.post(req, res);

    expect(h.undoDisputeContain).toHaveBeenCalledWith(dispute, ADMIN_ID, expect.anything());
    expect(res._getStatusCode()).toBe(200);
  });

  it('answers 409 when there is nothing to undo', async () => {
    h.findById.mockResolvedValue({ ...item(), containSnapshot: null });
    h.undoDisputeContain.mockRejectedValue(new h.DisputeContainUndoRefused({ status: 'conflict', item: item() }));
    const { req, res } = request('POST', { body: { id: DISPUTE_ID, reason: REASON } });

    await h.handlers.undo.post(req, res);

    expect(res._getStatusCode()).toBe(409);
  });

  it('answers 404 for an unknown dispute', async () => {
    h.findById.mockResolvedValue(null);
    const { req, res } = request('POST', { body: { id: DISPUTE_ID, reason: REASON } });
    await expect(h.handlers.undo.post(req, res)).rejects.toThrow('Dispute not found');
  });
});
