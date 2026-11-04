import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => handlers[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
      _config: config,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mocks = vi.hoisted(() => ({
  userFindById: vi.fn(),
  orgFindById: vi.fn(),
  orgFindByCustomer: vi.fn(),
  orgUpdate: vi.fn(),
  resolveForSubscription: vi.fn(),
  rowFindById: vi.fn(),
  updateReturningBefore: vi.fn(),
  modelFindById: vi.fn(),
  toRows: vi.fn(),
  setSeats: vi.fn(),
  retrieve: vi.fn(),
  audit: vi.fn(),
  send: vi.fn(),
  state: { inTransaction: false, auditInTransaction: undefined as boolean | undefined },
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mocks.userFindById },
  organizationRepository: {
    findById: mocks.orgFindById,
    findByStripeCustomerId: mocks.orgFindByCustomer,
    update: mocks.orgUpdate,
  },
  billingMismatchRepository: { resolveForSubscription: mocks.resolveForSubscription },
  withTransaction: async (fn: () => Promise<unknown>) => {
    mocks.state.inTransaction = true;
    try {
      return await fn();
    } finally {
      mocks.state.inTransaction = false;
    }
  },
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: {
    findById: mocks.rowFindById,
    updateByStripeSubscriptionIdReturningBefore: mocks.updateReturningBefore,
  },
  Subscription: { findById: () => ({ lean: mocks.modelFindById }) },
}));
vi.mock('@server/services/organizationService', () => ({ setSeats: mocks.setSeats }));
vi.mock('@server/admin/subscriptionsList/listAdminSubscriptions', () => ({ toAdminSubscriptionRows: mocks.toRows }));
vi.mock('@server/admin/subscriptionsList/adminSubscriptionsQuery', () => ({ subscriptionPlanCatalog: () => ({}) }));

// Only subscriptions.retrieve exists, so any Stripe write (update, cancel, create) throws.
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: new Proxy(
    {
      subscriptions: new Proxy(
        { retrieve: mocks.retrieve },
        { get: (o, p) => (p in o ? o[p as 'retrieve'] : fail(p)) }
      ),
    },
    { get: (o, p) => (p in o ? o[p as 'subscriptions'] : fail(p)) }
  ),
}));
function fail(prop: string | symbol): never {
  throw new Error(`Stripe write or unexpected call: ${String(prop)}`);
}

vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  const { ForbiddenError } = await import('@bike4mind/common');
  return {
    ...actual,
    recordAdminActionFromRequest: (...a: unknown[]) => {
      mocks.state.auditInTransaction = mocks.state.inTransaction;
      return mocks.audit(...a);
    },
    denySelfAdminAction: async (req: unknown, { action, attempted, target }: Record<string, unknown>) => {
      await mocks.audit(req, { action, target, details: { attemptedAction: attempted } });
      throw new ForbiddenError('Admins cannot perform this action on their own account.');
    },
  };
});
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: mocks.send }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import handler from '../sync';

const ID = 'c'.repeat(24);
const REASON = 'Webhook missed or failed';
const UPDATED_AT = new Date('2026-11-01T00:00:00Z');
const PERIOD_END = 1_802_592_000;

const row = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  ownerType: 'User',
  ownerId: 'u1',
  subscriptionId: 'sub_1',
  source: 'stripe',
  priceId: 'price_1',
  status: 'active',
  quantity: 1,
  periodStartsAt: new Date(1_800_000_000_000),
  periodEndsAt: new Date(PERIOD_END * 1000),
  canceledAt: null,
  cancelAtPeriodEnd: false,
  unitAmount: 2000,
  currency: 'usd',
  interval: 'month',
  intervalCount: 1,
  stripeCustomerId: 'cus_1',
  cancelAt: null,
  trialEndsAt: null,
  updatedAt: UPDATED_AT,
  ...overrides,
});

const stripeSub = (quantity = 3) => ({
  id: 'sub_1',
  status: 'active',
  canceled_at: null,
  currency: 'usd',
  customer: 'cus_1',
  cancel_at_period_end: false,
  cancel_at: null,
  trial_end: null,
  items: {
    data: [
      {
        price: {
          id: 'price_1',
          unit_amount: 2000,
          currency: 'usd',
          recurring: { interval: 'month', interval_count: 1 },
        },
        current_period_start: 1_800_000_000,
        current_period_end: PERIOD_END,
        quantity,
      },
    ],
  },
});

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
function call(method: 'GET' | 'POST', options: { body?: Record<string, unknown>; id?: string; adminId?: string } = {}) {
  const { req, res } = createMocks({
    method,
    query: { id: options.id ?? ID },
    body:
      method === 'POST' ? { reason: REASON, expectedUpdatedAt: UPDATED_AT.toISOString(), ...options.body } : undefined,
  });
  Object.assign(req, {
    user: { isAdmin: true, id: options.adminId ?? 'admin-1' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { res, run: () => (handler as unknown as Handler)(req, res) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.auditInTransaction = undefined;
  mocks.rowFindById.mockResolvedValue(row());
  mocks.userFindById.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });
  mocks.retrieve.mockResolvedValue(stripeSub());
  mocks.updateReturningBefore.mockResolvedValue(row());
  mocks.audit.mockResolvedValue(null);
  mocks.modelFindById.mockResolvedValue({ _id: ID });
  mocks.toRows.mockResolvedValue([{ id: ID }]);
});

describe('GET /api/admin/subscriptions/[id]/sync', () => {
  it('returns the diff from a live Stripe read and writes nothing', async () => {
    const { res, run } = call('GET');
    await run();

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.updatedAt).toBe(UPDATED_AT.toISOString());
    expect(body.stripeMissing).toBe(false);
    expect(body.changes).toEqual([{ field: 'quantity', before: '1', after: '3' }]);
    expect(mocks.retrieve).toHaveBeenCalledWith('sub_1');
    expect(mocks.updateReturningBefore).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('previews no changes for a row that already matches Stripe', async () => {
    mocks.rowFindById.mockResolvedValue(row({ quantity: 3 }));
    const { res, run } = call('GET');
    await run();

    expect(res._getJSONData().changes).toEqual([]);
  });

  it('previews a subscription Stripe no longer has as canceled', async () => {
    mocks.retrieve.mockRejectedValue(Object.assign(new Error('gone'), { code: 'resource_missing' }));
    const { res, run } = call('GET');
    await run();

    expect(res._getJSONData()).toMatchObject({ stripeMissing: true, stripeStatus: null });
    expect(res._getJSONData().changes).toEqual([
      { field: 'status', before: 'active', after: 'canceled' },
      { field: 'canceledAt', before: null, after: expect.any(String) },
    ]);
  });

  it('rejects a comp: there is nothing in Stripe to sync from', async () => {
    mocks.rowFindById.mockResolvedValue(row({ source: 'admin_grant', subscriptionId: 'admin_grant_1' }));
    const { res, run } = call('GET');
    await expect(run()).rejects.toThrow(/billed through Stripe/);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
  });
});

describe('POST /api/admin/subscriptions/[id]/sync', () => {
  it('writes Stripe values and audits the before and after of every changed field, seats included', async () => {
    mocks.rowFindById.mockResolvedValue(row({ ownerType: 'Organization', ownerId: 'org_1' }));
    mocks.updateReturningBefore.mockResolvedValue(row({ ownerType: 'Organization', ownerId: 'org_1' }));
    mocks.orgFindById.mockResolvedValue({ id: 'org_1', name: 'Acme', userId: 'boss-1' });
    mocks.orgFindByCustomer.mockResolvedValue({ id: 'org_1', seats: 5 });
    const { res, run } = call('POST');
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.updateReturningBefore).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({ status: 'active', quantity: 3, priceId: 'price_1', unitAmount: 2000 }),
      UPDATED_AT
    );
    expect(mocks.setSeats).toHaveBeenCalledWith('org_1', 3, { type: 'stripe' });
    const audit = mocks.audit.mock.calls[0][1];
    expect(audit.action).toBe('billing.subscription.synced');
    expect(audit.reason).toBe(REASON);
    expect(audit.changes).toEqual([
      { field: 'quantity', before: '1', after: '3' },
      { field: 'seats', before: '5', after: '3' },
    ]);
    expect(mocks.state.auditInTransaction).toBe(true);
    expect(mocks.resolveForSubscription).toHaveBeenCalledWith(ID, 'sync', expect.any(Date));
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
  });

  it('is a 400 without a reason', async () => {
    const { run } = call('POST', { body: { reason: undefined } });
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.updateReturningBefore).not.toHaveBeenCalled();
  });

  it('denies an admin syncing their own subscription', async () => {
    const { run } = call('POST', { adminId: 'u1' });
    await expect(run()).rejects.toThrow(/own account/);
    expect(mocks.updateReturningBefore).not.toHaveBeenCalled();
    expect(mocks.audit.mock.calls[0][1]).toMatchObject({ action: 'user.subscription.denied' });
  });

  it('is a 409 when the row changed since it was previewed', async () => {
    mocks.rowFindById.mockResolvedValue(row({ updatedAt: new Date(UPDATED_AT.getTime() + 1000) }));
    const { run } = call('POST');
    await expect(run()).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.updateReturningBefore).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it('marks the row canceled when Stripe has no such subscription', async () => {
    mocks.retrieve.mockRejectedValue(Object.assign(new Error('gone'), { code: 'resource_missing' }));
    const { res, run } = call('POST');
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.updateReturningBefore).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({ status: 'canceled', canceledAt: expect.any(Date) }),
      UPDATED_AT
    );
    expect(mocks.audit.mock.calls[0][1].changes).toEqual([
      { field: 'status', before: 'active', after: 'canceled' },
      { field: 'canceledAt', before: null, after: expect.any(String) },
    ]);
    expect(mocks.audit.mock.calls[0][1].summary).toBe(
      'synced subscription from Stripe (gone from Stripe, marked canceled)'
    );
    expect(mocks.audit.mock.calls[0][1].details).toMatchObject({ stripeMissing: true });
  });

  it('leaves an already-canceled row untouched when Stripe has no such subscription', async () => {
    mocks.rowFindById.mockResolvedValue(row({ status: 'canceled', canceledAt: new Date('2025-03-01T00:00:00Z') }));
    mocks.retrieve.mockRejectedValue(Object.assign(new Error('gone'), { code: 'resource_missing' }));
    const { res, run } = call('POST');
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.updateReturningBefore).not.toHaveBeenCalled();
    expect(mocks.audit.mock.calls[0][1].changes).toEqual([]);
    expect(mocks.audit.mock.calls[0][1].summary).toBe(
      'synced subscription from Stripe (gone from Stripe, already finished)'
    );
  });

  it('leaves an incomplete_expired row untouched when Stripe has no such subscription', async () => {
    mocks.rowFindById.mockResolvedValue(row({ status: 'incomplete_expired' }));
    mocks.retrieve.mockRejectedValue(Object.assign(new Error('gone'), { code: 'resource_missing' }));
    const { res, run } = call('POST');
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.updateReturningBefore).not.toHaveBeenCalled();
    expect(mocks.audit.mock.calls[0][1].changes).toEqual([]);
    expect(mocks.audit.mock.calls[0][1].summary).toBe(
      'synced subscription from Stripe (gone from Stripe, already finished)'
    );
  });

  it('is a 409, with no seat write or audit, when the row changed after the precheck', async () => {
    mocks.rowFindById.mockResolvedValue(row({ ownerType: 'Organization', ownerId: 'org_1' }));
    mocks.orgFindById.mockResolvedValue({ id: 'org_1', name: 'Acme', userId: 'boss-1' });
    mocks.orgFindByCustomer.mockResolvedValue({ id: 'org_1', seats: 5 });
    mocks.updateReturningBefore.mockResolvedValue(null);
    const { run } = call('POST');

    await expect(run()).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.updateReturningBefore).toHaveBeenCalledWith('sub_1', expect.anything(), UPDATED_AT);
    expect(mocks.setSeats).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.resolveForSubscription).not.toHaveBeenCalled();
  });

  it('rejects a comp', async () => {
    mocks.rowFindById.mockResolvedValue(row({ source: 'admin_grant', subscriptionId: 'admin_grant_1' }));
    const { run } = call('POST');
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
});
