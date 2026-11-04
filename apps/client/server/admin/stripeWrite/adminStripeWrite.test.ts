import { beforeEach, describe, expect, it, vi } from 'vitest';

const dedup = new Map<string, Record<string, unknown>>();
const mockUserFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  organizationRepository: { findById: vi.fn() },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  cacheRepository: {
    claimDedup: async (key: string, data: Record<string, unknown>) => {
      const existing = dedup.get(key);
      if (existing) return { claimed: false, existingData: existing };
      dedup.set(key, data);
      return { claimed: true };
    },
    casUpdateDedup: async (key: string, field: string, value: string, data: Record<string, unknown>) => {
      if (dedup.get(key)?.[field] !== value) return false;
      dedup.set(key, data);
      return true;
    },
    casDeleteDedup: async (key: string, field: string, value: string) => {
      if (dedup.get(key)?.[field] !== value) return false;
      dedup.delete(key);
      return true;
    },
  },
}));

const mockFindById = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockModelFindById = vi.fn();
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
  Subscription: {
    findById: (...a: unknown[]) => ({ lean: () => mockModelFindById(...a) }),
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
  },
}));

const mockStripeUpdate = vi.fn();
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  getStripe: () => ({ subscriptions: { update: mockStripeUpdate } }),
}));

let production = true;
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { STRIPE_SECRET_KEY: 'sk_test_123' },
  isProduction: () => production,
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws' } } }));
vi.mock('@server/admin/subscriptionsList/adminSubscriptionsQuery', () => ({ subscriptionPlanCatalog: () => ({}) }));
vi.mock('@server/admin/subscriptionsList/listAdminSubscriptions', () => ({
  toAdminSubscriptionRows: async () => [{ id: 'row' }],
}));

const mockRecordAdminAction = vi.fn();
vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  const { ForbiddenError } = await import('@bike4mind/common');
  return {
    ...actual,
    recordAdminActionFromRequest: (...a: unknown[]) => mockRecordAdminAction(...a),
    denySelfAdminAction: async (_req: unknown, { action, attempted }: Record<string, unknown>) => {
      await mockRecordAdminAction(_req, { action, details: { attemptedAction: attempted } });
      throw new ForbiddenError('Admins cannot perform this action on their own account.');
    },
  };
});

import { assertStripeKeyMatchesStage, runAdminStripeWrite } from './adminStripeWrite';

const ID = 'c'.repeat(24);
const SYNCED = '2026-11-01T00:00:00.000Z';
const KEY = 'idem-key-0001';

const stripeSub = {
  cancel_at_period_end: true,
  cancel_at: null,
  trial_end: null,
  currency: 'usd',
  customer: 'cus_test_1',
  items: {
    data: [{ price: { unit_amount: 1000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }],
  },
  lastResponse: { requestId: 'req_1' },
};

const makeReq = (overrides: Record<string, unknown> = {}) => ({
  user: { id: 'admin-1', isAdmin: true },
  body: { reason: 'Customer request', idempotencyKey: KEY, expectedLastSyncedAt: SYNCED },
  logger: { error: vi.fn() },
  ...overrides,
});

const run = (req: ReturnType<typeof makeReq>, precheck: (s: unknown) => void = () => undefined) =>
  runAdminStripeWrite({
    req: req as never,
    id: ID,
    action: 'billing.subscription.cancel_scheduled',
    summary: 'scheduled cancellation at period end',
    precheck,
    mutate: (stripe, { idempotencyKey, subscription }) =>
      stripe.subscriptions.update(
        subscription.subscriptionId,
        { cancel_at_period_end: true },
        { idempotencyKey }
      ) as never,
    changes: () => [{ field: 'cancelAtPeriodEnd', before: false, after: true }],
  });

describe('assertStripeKeyMatchesStage', () => {
  const check = (production: boolean, key: string, selfHost = false) =>
    assertStripeKeyMatchesStage({ production, selfHost, key });

  it('refuses a live key on a non-production stage', () => {
    expect(() => check(false, 'sk_live_abc')).toThrow('live Stripe key');
    expect(() => check(false, 'rk_live_abc')).toThrow('live Stripe key');
  });

  it('allows a live key in production and on a self-hosted install, and a test key anywhere', () => {
    expect(() => check(true, 'sk_live_abc')).not.toThrow();
    expect(() => check(false, 'sk_live_abc', true)).not.toThrow();
    expect(() => check(false, 'sk_test_abc')).not.toThrow();
  });
});

describe('runAdminStripeWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dedup.clear();
    production = true;
    mockFindById.mockResolvedValue({
      ownerType: 'User',
      ownerId: 'u1',
      subscriptionId: 'sub_123',
      lastSyncedAt: new Date(SYNCED),
    });
    mockUserFindById.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });
    mockStripeUpdate.mockResolvedValue(stripeSub);
    mockModelFindById.mockResolvedValue({ _id: ID });
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockRecordAdminAction.mockResolvedValue(null);
  });

  it('calls Stripe once with the key and the Stripe id, and audits strictly with the request id', async () => {
    const response = await run(makeReq());

    expect(mockStripeUpdate).toHaveBeenCalledTimes(1);
    expect(mockStripeUpdate).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: true }, { idempotencyKey: KEY });
    expect(mockRecordAdminAction).toHaveBeenCalledTimes(1);
    expect(mockRecordAdminAction.mock.calls[0][1]).toMatchObject({
      action: 'billing.subscription.cancel_scheduled',
      reason: 'Customer request',
      details: { stripeRequestId: 'req_1', subscriptionId: 'sub_123' },
    });
    expect(response.subscription).toEqual({ id: 'row' });
  });

  it('makes one Stripe call for a concurrent double submit and replays the stored response afterwards', async () => {
    let release!: () => void;
    mockStripeUpdate.mockImplementationOnce(() => new Promise(resolve => (release = () => resolve(stripeSub))));

    const first = run(makeReq());
    await vi.waitFor(() => expect(mockStripeUpdate).toHaveBeenCalledTimes(1));
    await expect(run(makeReq())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('in progress'),
    });
    release();
    const firstResponse = await first;

    const replay = await run(makeReq());
    expect(replay).toEqual(firstResponse);
    expect(mockStripeUpdate).toHaveBeenCalledTimes(1);
    expect(mockRecordAdminAction).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the audit write fails so a same-key retry re-runs with the same Stripe key', async () => {
    mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));
    await expect(run(makeReq())).rejects.toThrow('audit down');

    await run(makeReq());
    expect(mockStripeUpdate).toHaveBeenCalledTimes(2);
    expect(mockStripeUpdate.mock.calls[1][2]).toEqual({ idempotencyKey: KEY });
    expect(mockRecordAdminAction).toHaveBeenCalledTimes(2);
  });

  it('409s on a stale preview without calling Stripe, and frees the key', async () => {
    const req = makeReq({ body: { reason: 'Customer request', idempotencyKey: KEY, expectedLastSyncedAt: null } });
    await expect(run(req)).rejects.toMatchObject({
      statusCode: 409,
      message: 'This subscription changed. Review and try again.',
    });
    expect(mockStripeUpdate).not.toHaveBeenCalled();
    expect(dedup.size).toBe(0);
  });

  it('runs the route precheck on the fresh row and does not call Stripe when it throws', async () => {
    await expect(
      run(makeReq(), () => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');
    expect(mockStripeUpdate).not.toHaveBeenCalled();
  });

  it('refuses a non-admin and an impersonated session before anything else', async () => {
    await expect(run(makeReq({ user: { id: 'a', isAdmin: false } }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(run(makeReq({ user: { id: 'a', isAdmin: true, impersonatedBy: 'root' } }))).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockStripeUpdate).not.toHaveBeenCalled();
  });

  it('denies and audits a self-targeted write', async () => {
    mockFindById.mockResolvedValue({ ownerType: 'User', ownerId: 'admin-1', subscriptionId: 'sub_1' });
    await expect(run(makeReq())).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRecordAdminAction.mock.calls[0][1]).toMatchObject({ action: 'user.subscription.denied' });
    expect(mockStripeUpdate).not.toHaveBeenCalled();
  });

  it('400s without a reason or with a short key', async () => {
    await expect(run(makeReq({ body: { idempotencyKey: KEY, expectedLastSyncedAt: SYNCED } }))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      run(makeReq({ body: { reason: 'Customer request', idempotencyKey: 'short', expectedLastSyncedAt: SYNCED } }))
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockStripeUpdate).not.toHaveBeenCalled();
  });

  it('refuses a live key on a non-production stage before touching Stripe', async () => {
    production = false;
    const config = await import('@bike4mind/server-utils/utils/config');
    (config.Config as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_live_abc';
    try {
      await expect(run(makeReq())).rejects.toThrow('live Stripe key');
    } finally {
      (config.Config as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_123';
    }
    expect(mockStripeUpdate).not.toHaveBeenCalled();
  });
});
