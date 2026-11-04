import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const rateLimitOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: { method?: string }, res: unknown) => handlers[req.method ?? 'POST']?.(req, res),
      {
        use: () => chain,
        post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => (rateLimitOptions.push(options), () => undefined),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const dedup = new Map<string, Record<string, unknown>>();
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: async () => ({ id: 'u1', email: 'u1@example.com' }) },
  organizationRepository: { findById: vi.fn() },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  cacheRepository: {
    claimDedup: async (key: string, data: Record<string, unknown>) => {
      const existing = dedup.get(key);
      if (existing) return { claimed: false, existingData: existing };
      dedup.set(key, data);
      return { claimed: true };
    },
    casUpdateDedup: async (key: string, _f: string, _v: string, data: Record<string, unknown>) => {
      dedup.set(key, data);
      return true;
    },
    casDeleteDedup: async (key: string) => dedup.delete(key),
  },
}));

const mockFindById = vi.fn();
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
  Subscription: {
    findById: () => ({ lean: async () => ({ _id: 'x' }) }),
    findOneAndUpdate: async () => null,
  },
}));

const mockStripeUpdate = vi.fn();
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  getStripe: () => ({ subscriptions: { update: (...a: unknown[]) => mockStripeUpdate(...a) } }),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { STRIPE_SECRET_KEY: 'sk_test_123' },
  isProduction: () => false,
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
  return { ...actual, recordAdminActionFromRequest: (...a: unknown[]) => mockRecordAdminAction(...a) };
});

import { ADMIN_ACTION_REASON_MISSING_MESSAGE } from '@server/utils/adminAudit';
import handler from '../cancel';

import { stripeStateToken } from '@client/app/utils/adminSubscriptionDetail';

const ID = 'd'.repeat(24);
const SYNCED = '2026-11-01T00:00:00.000Z';
const DAY = 86_400_000;

const stripeSub = (overrides: Record<string, unknown> = {}) => ({
  cancel_at_period_end: true,
  cancel_at: null,
  trial_end: null,
  currency: 'usd',
  customer: 'cus_test_1',
  items: {
    data: [{ price: { unit_amount: 1000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }],
  },
  lastResponse: { requestId: 'req_1' },
  ...overrides,
});

const stripeRow = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  ownerType: 'User',
  ownerId: 'u1',
  subscriptionId: 'sub_test_1',
  source: 'stripe',
  status: 'active',
  periodEndsAt: new Date(Date.now() + 10 * DAY),
  lastSyncedAt: new Date(SYNCED),
  ...overrides,
});

let keyCounter = 0;
async function call(
  handler: unknown,
  options: { isAdmin?: boolean; body?: Record<string, unknown>; adminId?: string } = {}
) {
  const expectedState = stripeStateToken(await mockFindById());
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: ID },
    body: {
      reason: 'Customer request',
      idempotencyKey: `route-test-key-${++keyCounter}`,
      expectedState,
      ...(options.body ?? {}),
    },
  });
  Object.assign(req, {
    user: { isAdmin: options.isAdmin ?? true, id: options.adminId ?? 'admin-1' },
    logger: { info: vi.fn(), error: vi.fn() },
  });
  await (handler as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
  return res;
}

describe('POST /api/admin/subscriptions/[id]/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dedup.clear();
    mockFindById.mockResolvedValue(stripeRow());
    mockStripeUpdate.mockResolvedValue(stripeSub());
    mockRecordAdminAction.mockResolvedValue(null);
  });

  it('requires JWT auth with admin scope and a 10/min shared Stripe-write bucket', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
    expect(rateLimitOptions).toContainEqual({ limit: 10, windowMs: 60_000, bucket: 'admin-stripe-write' });
  });

  it('schedules the cancel at Stripe, mirrors it and writes a critical audit entry with before/after', async () => {
    const res = await call(handler, { body: { idempotencyKey: 'cancel-happy-key' } });

    expect(res._getStatusCode()).toBe(200);
    expect(mockStripeUpdate).toHaveBeenCalledWith(
      'sub_test_1',
      { cancel_at_period_end: true },
      expect.objectContaining({
        idempotencyKey: `${ID}:billing.subscription.cancel_scheduled:cancel-happy-key`,
        timeout: expect.any(Number),
      })
    );
    expect(mockRecordAdminAction).toHaveBeenCalledTimes(1);
    expect(mockRecordAdminAction.mock.calls[0][1]).toMatchObject({
      action: 'billing.subscription.cancel_scheduled',
      reason: 'Customer request',
      changes: [
        { field: 'cancelAtPeriodEnd', before: false, after: true },
        { field: 'cancelAt', before: null, after: null },
      ],
    });
    expect(mockRecordAdminAction.mock.calls[0][1].details).toEqual({
      subscriptionId: 'sub_test_1',
      subscriptionRecordId: ID,
      stripeRequestId: 'req_1',
    });
    expect(res._getJSONData().stripe).toMatchObject({ stateToken: expect.any(String) });
  });

  it.each([
    ['a comp', { source: 'admin_grant', subscriptionId: 'admin_grant_1' }],
    ['an ended subscription', { status: 'canceled' }],
    ['one already scheduled', { cancelAtPeriodEnd: true }],
    ['one with a custom cancel date', { cancelAt: new Date(Date.now() + 5 * DAY) }],
  ])('409s for %s without calling Stripe', async (_name, overrides) => {
    mockFindById.mockResolvedValue(stripeRow(overrides));
    await expect(call(handler)).rejects.toMatchObject({ statusCode: 409 });
    expect(mockStripeUpdate).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).not.toHaveBeenCalled();
  });

  it('409s when the reviewed state no longer matches the row, without calling Stripe', async () => {
    await expect(call(handler, { body: { expectedState: '["active",true,null,null]' } })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mockStripeUpdate).not.toHaveBeenCalled();
  });

  it('400s without a reason and 403s for a non-admin', async () => {
    await expect(call(handler, { body: { reason: undefined } })).rejects.toMatchObject({
      statusCode: 400,
      message: ADMIN_ACTION_REASON_MISSING_MESSAGE,
    });
    await expect(call(handler, { isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockStripeUpdate).not.toHaveBeenCalled();
  });
});
