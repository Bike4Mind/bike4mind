import { beforeEach, describe, expect, it, vi } from 'vitest';

const dedup = new Map<string, Record<string, unknown>>();
const claimTtls: Array<number | undefined> = [];
const updateTtls: Array<number | undefined> = [];
const mockUserFindById = vi.fn();
const mockOrgFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  organizationRepository: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  cacheRepository: {
    claimDedup: async (key: string, data: Record<string, unknown>, ttlMs?: number) => {
      claimTtls.push(ttlMs);
      const existing = dedup.get(key);
      if (existing) return { claimed: false, existingData: existing };
      dedup.set(key, data);
      return { claimed: true };
    },
    casUpdateDedup: async (
      key: string,
      field: string,
      value: string,
      data: Record<string, unknown>,
      ttlMs?: number
    ) => {
      updateTtls.push(ttlMs);
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
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>();
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

import { stripeStateToken } from '@client/app/utils/adminSubscriptionDetail';
import { assertStripeKeyMatchesStage, runAdminStripeWrite, type AdminStripeWriteAction } from './adminStripeWrite';

const ID = 'c'.repeat(24);
const SYNCED = '2026-11-01T00:00:00.000Z';
const KEY = 'idem-key-0001';
const PERIOD_END = new Date('2026-12-01T00:00:00.000Z');
const baseRow = {
  ownerType: 'User',
  ownerId: 'u1',
  subscriptionId: 'sub_123',
  status: 'active',
  periodEndsAt: PERIOD_END,
  lastSyncedAt: new Date(SYNCED),
};
const STATE = stripeStateToken(baseRow);

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
  body: { reason: 'Customer request', idempotencyKey: KEY, expectedState: STATE },
  logger: { error: vi.fn() },
  ...overrides,
});

type Row = { cancelAtPeriodEnd?: boolean };
const constantParams = () => ({ cancel_at_period_end: true });
const constantChanges = () => [{ field: 'cancelAtPeriodEnd', before: false, after: true }];

const run = (
  req: ReturnType<typeof makeReq>,
  precheck: (s: unknown) => void = () => undefined,
  action: AdminStripeWriteAction = 'billing.subscription.cancel_scheduled',
  callbacks: { params?: (s: Row) => Record<string, unknown>; changes?: (b: Row, a: typeof stripeSub) => unknown[] } = {}
) =>
  runAdminStripeWrite({
    req: req as never,
    id: ID,
    action,
    summary: 'scheduled cancellation at period end',
    precheck,
    params: (callbacks.params ?? constantParams) as never,
    changes: (callbacks.changes ?? constantChanges) as never,
  });

const STRIPE_KEY = `${ID}:billing.subscription.cancel_scheduled:${KEY}`;
const stripeError = (type: string, statusCode?: number) => Object.assign(new Error(type), { type, statusCode });
// The state our own webhook leaves after a cancel: the row now shows it, with a newer stamp.
const webhookLanded = () =>
  mockFindById.mockResolvedValue({ ...baseRow, cancelAtPeriodEnd: true, lastSyncedAt: new Date() });
const auditCalls = () => mockRecordAdminAction.mock.calls.filter(([, entry]) => entry.action.startsWith('billing.'));

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
    claimTtls.length = 0;
    updateTtls.length = 0;
    production = true;
    mockFindById.mockResolvedValue(baseRow);
    mockUserFindById.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });
    mockStripeUpdate.mockResolvedValue(stripeSub);
    mockModelFindById.mockResolvedValue({ _id: ID, ...baseRow });
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockRecordAdminAction.mockResolvedValue(null);
  });

  it('calls Stripe once with the key and the Stripe id, and audits strictly with the request id', async () => {
    const response = await run(makeReq());

    expect(mockStripeUpdate).toHaveBeenCalledTimes(1);
    expect(mockStripeUpdate).toHaveBeenCalledWith(
      'sub_123',
      { cancel_at_period_end: true },
      { idempotencyKey: STRIPE_KEY, timeout: 15_000, maxNetworkRetries: 1 }
    );
    expect(mockRecordAdminAction).toHaveBeenCalledTimes(1);
    expect(mockRecordAdminAction.mock.calls[0][1]).toMatchObject({
      action: 'billing.subscription.cancel_scheduled',
      reason: 'Customer request',
      details: { stripeRequestId: 'req_1', subscriptionId: 'sub_123' },
    });
    expect(response.subscription).toEqual({ id: 'row' });
    expect(response.stripe).toEqual({ lastSyncedAt: SYNCED, cancelAtPeriodEnd: false, stateToken: STATE });
  });

  it('mirrors the Stripe response with a newer-wins filter that also matches a missing or null stamp', async () => {
    await run(makeReq());

    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe(ID);
    expect(filter.$or).toEqual([{ lastSyncedAt: { $lte: expect.any(Date) } }, { lastSyncedAt: null }]);
    expect(update.$set).toMatchObject({ cancelAtPeriodEnd: true, lastSyncedAt: filter.$or[0].lastSyncedAt.$lte });
  });

  it('accepts a write after our own webhook re-stamped lastSyncedAt without changing the business state', async () => {
    mockFindById.mockResolvedValue({ ...baseRow, lastSyncedAt: new Date('2026-11-04T10:00:05.000Z') });
    await run(makeReq());
    expect(mockStripeUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not replay another action that reused the same idempotency key', async () => {
    await run(makeReq());
    await run(makeReq(), () => undefined, 'billing.subscription.resumed');

    expect(mockStripeUpdate).toHaveBeenCalledTimes(2);
    expect(mockRecordAdminAction.mock.calls.map(([, entry]) => entry.action)).toEqual([
      'billing.subscription.cancel_scheduled',
      'billing.subscription.resumed',
    ]);
  });

  it('denies a write on an org-owned subscription whose billing owner is the admin', async () => {
    mockFindById.mockResolvedValue({ ...baseRow, ownerType: 'Organization', ownerId: 'org-1' });
    mockOrgFindById.mockResolvedValue({ id: 'org-1', name: 'Acme', userId: 'admin-1' });
    await expect(run(makeReq())).rejects.toMatchObject({ statusCode: 403 });
    expect(mockStripeUpdate).not.toHaveBeenCalled();
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

  it('writes the audit on a same-key retry after the audit failed, even once the row has changed', async () => {
    mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));
    await expect(run(makeReq())).rejects.toThrow('audit down');

    // Our webhook landed: the row now shows the cancel and a newer stamp, so the state check and precheck would fail.
    mockFindById.mockResolvedValue({ ...baseRow, cancelAtPeriodEnd: true, lastSyncedAt: new Date() });
    const strictPrecheck = vi.fn(() => {
      throw new Error('already scheduled');
    });
    const response = await run(makeReq(), strictPrecheck);

    expect(strictPrecheck).not.toHaveBeenCalled();
    expect(mockStripeUpdate).toHaveBeenCalledTimes(2);
    expect(mockStripeUpdate.mock.calls[1]).toEqual(mockStripeUpdate.mock.calls[0]);
    const audits = auditCalls();
    expect(audits).toHaveLength(2);
    expect(audits[1][1]).toMatchObject({
      action: 'billing.subscription.cancel_scheduled',
      changes: [{ field: 'cancelAtPeriodEnd', before: false, after: true }],
    });
    expect(response.subscription).toEqual({ id: 'row' });
  });

  describe('recovery of a write Stripe applied', () => {
    // Row-dependent callbacks, so a recovery that recomputes from the post-webhook row instead of replaying the
    // stored request and audit changes shows up as a different Stripe call or audit entry.
    const flip = {
      params: (s: Row) => ({ cancel_at_period_end: !s.cancelAtPeriodEnd }),
      // Reads Stripe's response, which the second attempt below answers differently from the first.
      changes: (b: Row, after: typeof stripeSub) => [
        { field: 'cancelAtPeriodEnd', before: Boolean(b.cancelAtPeriodEnd), after: after.cancel_at_period_end },
      ],
    };
    const runFlip = () => run(makeReq(), undefined, undefined, flip);

    it('replays the stored request and audit changes, not ones recomputed from the changed row', async () => {
      mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));
      await expect(runFlip()).rejects.toThrow('audit down');
      webhookLanded();
      mockStripeUpdate.mockResolvedValueOnce({ ...stripeSub, cancel_at_period_end: false });
      await runFlip();

      expect(mockStripeUpdate.mock.calls[0][1]).toEqual({ cancel_at_period_end: true });
      expect(mockStripeUpdate.mock.calls[1]).toEqual(mockStripeUpdate.mock.calls[0]);
      expect(auditCalls()[1][1].changes).toEqual([{ field: 'cancelAtPeriodEnd', before: false, after: true }]);
    });

    it('does not write the replayed Stripe snapshot over a newer mirror, but still audits', async () => {
      mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));
      await expect(run(makeReq())).rejects.toThrow('audit down');
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);

      webhookLanded();
      await run(makeReq());

      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(auditCalls()).toHaveLength(2);
    });

    it('keeps the record when the recovery attempt itself fails, so a third same-key call audits once', async () => {
      mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));
      await expect(runFlip()).rejects.toThrow('audit down');
      webhookLanded();
      mockStripeUpdate.mockRejectedValueOnce(stripeError('StripeRateLimitError', 429));
      await expect(runFlip()).rejects.toThrow('StripeRateLimitError');
      expect(dedup.get(`admin-stripe-write:admin-1:${ID}:billing.subscription.cancel_scheduled:${KEY}`)).toMatchObject({
        state: 'stripe_done',
      });

      await runFlip();

      expect(mockStripeUpdate).toHaveBeenCalledTimes(3);
      expect(mockStripeUpdate.mock.calls[2]).toEqual(mockStripeUpdate.mock.calls[0]);
      expect(auditCalls()).toHaveLength(2); // the failed first attempt and the one that succeeded
      expect(auditCalls()[1][1].changes).toEqual([{ field: 'cancelAtPeriodEnd', before: false, after: true }]);
    });

    it('carries the pre-write row across a failed recovery, so the audit never diffs the post-webhook row', async () => {
      mockStripeUpdate.mockRejectedValueOnce(stripeError('StripeAPIError', 503));
      await expect(runFlip()).rejects.toThrow();
      webhookLanded();
      mockStripeUpdate.mockRejectedValueOnce(stripeError('StripeRateLimitError', 429));
      await expect(runFlip()).rejects.toThrow('StripeRateLimitError');
      await runFlip();

      expect(auditCalls()).toHaveLength(1);
      expect(auditCalls()[0][1].changes).toEqual([{ field: 'cancelAtPeriodEnd', before: false, after: true }]);
    });

    it('does not park once the audit committed, so a same-key retry never audits twice', async () => {
      mockModelFindById.mockRejectedValueOnce(new Error('read down'));
      await expect(runFlip()).rejects.toThrow();
      webhookLanded();
      await expect(runFlip()).rejects.toMatchObject({ statusCode: 409 });

      expect(auditCalls()).toHaveLength(1);
      expect(mockStripeUpdate).toHaveBeenCalledTimes(1);
    });

    it('sets the claim TTL once and never extends it on a rewrite', async () => {
      mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));
      await expect(run(makeReq())).rejects.toThrow('audit down');
      webhookLanded();
      await run(makeReq());

      expect(claimTtls).toEqual([24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]);
      expect(updateTtls.length).toBeGreaterThanOrEqual(3);
      expect(updateTtls.every(ttl => ttl === undefined)).toBe(true);
    });

    it.each([
      ['a timeout or connection error', stripeError('StripeConnectionError')],
      ['a 5xx', stripeError('StripeAPIError', 503)],
      ['a 409 (same key still in progress)', stripeError('StripeAPIError', 409)],
    ])('parks the claim on %s, then audits on a same-key retry after the webhook', async (_name, error) => {
      mockStripeUpdate.mockRejectedValueOnce(error);
      await expect(runFlip()).rejects.toThrow();
      webhookLanded();
      await runFlip();

      expect(mockStripeUpdate).toHaveBeenCalledTimes(2);
      expect(mockStripeUpdate.mock.calls[1]).toEqual(mockStripeUpdate.mock.calls[0]);
      expect(auditCalls()).toHaveLength(1);
      expect(auditCalls()[0][1].changes).toEqual([{ field: 'cancelAtPeriodEnd', before: false, after: true }]);
    });

    it.each([
      ['a 4xx invalid request', stripeError('StripeInvalidRequestError', 400)],
      ['a rate limit', stripeError('StripeRateLimitError', 429)],
      ['a 4xx API error', stripeError('StripeAPIError', 400)],
    ])('releases the claim on %s', async (_name, error) => {
      mockStripeUpdate.mockRejectedValueOnce(error);
      await expect(runFlip()).rejects.toThrow();
      expect(dedup.size).toBe(0);
    });
  });

  it('keeps one admin claim apart from another using the same key on the same subscription', async () => {
    await run(makeReq());
    await run(makeReq({ user: { id: 'admin-2', isAdmin: true } }));

    expect(mockStripeUpdate).toHaveBeenCalledTimes(2);
    expect(auditCalls()).toHaveLength(2);
  });

  it('releases the claim when Stripe itself fails so the retry starts clean', async () => {
    mockStripeUpdate.mockRejectedValueOnce(new Error('stripe down'));
    await expect(run(makeReq())).rejects.toThrow('stripe down');
    expect(dedup.size).toBe(0);
    await run(makeReq());
    expect(mockStripeUpdate).toHaveBeenCalledTimes(2);
  });

  it('409s on a stale preview without calling Stripe, and frees the key', async () => {
    const req = makeReq({ body: { reason: 'Customer request', idempotencyKey: KEY, expectedState: 'stale' } });
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
    await expect(run(makeReq({ body: { idempotencyKey: KEY, expectedState: STATE } }))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      run(makeReq({ body: { reason: 'Customer request', idempotencyKey: 'short', expectedState: STATE } }))
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockStripeUpdate).not.toHaveBeenCalled();
  });

  it('allows a live key on a self-hosted install, read from B4M_SELF_HOST', async () => {
    production = false;
    vi.stubEnv('B4M_SELF_HOST', 'true');
    const config = await import('@bike4mind/server-utils/utils/config');
    (config.Config as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_live_abc';
    try {
      await run(makeReq());
    } finally {
      (config.Config as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_123';
      vi.unstubAllEnvs();
    }
    expect(mockStripeUpdate).toHaveBeenCalledTimes(1);
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
