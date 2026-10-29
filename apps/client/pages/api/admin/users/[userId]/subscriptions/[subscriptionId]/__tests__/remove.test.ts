import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'DELETE']?.(req, res),
      {
        use: () => chain,
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((h.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/server-utils/utils/errors', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/utils/errors')>();
  return { ...actual, ForbiddenError: class ForbiddenError extends Error {} };
});

const mockUserFindById = vi.fn();
const mockOrgFindById = vi.fn();
let inTransaction = false;
let insideTransactionAtAudit: boolean | undefined;
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  userRepository: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  withTransaction: async (fn: (session: unknown) => Promise<unknown>) => {
    inTransaction = true;
    try {
      return await fn(undefined);
    } finally {
      inTransaction = false;
    }
  },
}));

const mockFindByStripeSubId = vi.fn();
const mockDelete = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findByStripeSubscriptionId: (...a: unknown[]) => mockFindByStripeSubId(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));

const mockRecordAdminAction = vi.fn();
vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  return {
    ...actual,
    recordAdminActionFromRequest: (...a: unknown[]) => {
      insideTransactionAtAudit = inTransaction;
      return mockRecordAdminAction(...a);
    },
  };
});

const mockSendToClient = vi.fn();
vi.mock('@server/websocket/utils', () => ({ sendToClient: (...a: unknown[]) => mockSendToClient(...a) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { LIVE_STRIPE_SUBSCRIPTION_REMOVE_MESSAGE } from '@bike4mind/server-utils/lib/subscriptions/types';
import { ADMIN_ACTION_REASON_MISSING_MESSAGE } from '@server/utils/adminAudit';
import handler from '../remove';

const VALID_REASON = 'Billing correction';

function call(body: Record<string, unknown> = { reason: VALID_REASON }) {
  const { req, res } = createMocks({
    method: 'DELETE',
    query: { userId: 'u1', subscriptionId: 'sub_123' },
    body,
  });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = { isAdmin: true, id: 'admin-1' };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('DELETE /api/admin/users/[userId]/subscriptions/[subscriptionId]/remove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insideTransactionAtAudit = undefined;
    mockUserFindById.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });
    mockFindByStripeSubId.mockResolvedValue({
      id: 'sub-1',
      ownerType: 'User',
      ownerId: 'u1',
      source: 'admin_grant',
      priceId: 'price_x',
      status: 'active',
      quantity: 1,
    });
    mockDelete.mockResolvedValue(undefined);
    mockRecordAdminAction.mockResolvedValue(null);
  });

  it('records user.subscription.removed for an individual subscription inside the deleting transaction', async () => {
    const { res, run } = call();
    await run();

    expect(mockDelete).toHaveBeenCalledWith('sub-1');
    expect(insideTransactionAtAudit).toBe(true);
    expect(mockRecordAdminAction).toHaveBeenCalledTimes(1);
    expect(mockRecordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.subscription.removed',
        target: { kind: 'user', id: 'u1', displayName: 'u1@example.com' },
        reason: VALID_REASON,
        details: expect.objectContaining({ subscriptionId: 'sub_123', priceId: 'price_x' }),
      })
    );
    expect(res._getStatusCode()).toBe(200);
  });

  it('tags the organization when a team subscription is removed', async () => {
    mockFindByStripeSubId.mockResolvedValue({
      id: 'sub-2',
      ownerType: 'Organization',
      ownerId: 'org-1',
      source: 'admin_grant',
      priceId: 'price_team',
      status: 'active',
      quantity: 4,
    });
    mockOrgFindById.mockResolvedValue({ id: 'org-1', users: [] });

    const { run } = call();
    await run();

    expect(insideTransactionAtAudit).toBe(true);
    expect(mockRecordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.subscription.removed',
        organizationId: 'org-1',
        details: expect.objectContaining({ quantity: 4 }),
      })
    );
  });

  it('returns 400 and deletes nothing when no reason is sent', async () => {
    const { res, run } = call({});

    await expect(run()).rejects.toMatchObject({ statusCode: 400, message: ADMIN_ACTION_REASON_MISSING_MESSAGE });

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).not.toHaveBeenCalled();
    expect(res._getData()).toBe('');
  });

  it('returns 400 and deletes nothing for a too-short reason', async () => {
    const { run } = call({ reason: 'abc' });

    await expect(run()).rejects.toMatchObject({ statusCode: 400 });

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).not.toHaveBeenCalled();
  });

  it('returns 409 and deletes nothing for an active Stripe-billed subscription', async () => {
    mockFindByStripeSubId.mockResolvedValue({
      id: 'sub-3',
      ownerType: 'User',
      ownerId: 'u1',
      source: 'stripe',
      subscriptionId: 'sub_123',
      status: 'active',
    });

    const { run } = call();

    await expect(run()).rejects.toMatchObject({
      statusCode: 409,
      message: LIVE_STRIPE_SUBSCRIPTION_REMOVE_MESSAGE,
    });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).not.toHaveBeenCalled();
  });

  it('removes an active admin-granted subscription', async () => {
    mockFindByStripeSubId.mockResolvedValue({
      id: 'sub-4',
      ownerType: 'User',
      ownerId: 'u1',
      subscriptionId: 'admin_granted_abc',
      status: 'active',
    });

    const { res, run } = call();
    await run();

    expect(mockDelete).toHaveBeenCalledWith('sub-4');
    expect(res._getStatusCode()).toBe(200);
  });

  it('removes a canceled Stripe subscription', async () => {
    mockFindByStripeSubId.mockResolvedValue({
      id: 'sub-5',
      ownerType: 'User',
      ownerId: 'u1',
      source: 'stripe',
      subscriptionId: 'sub_123',
      status: 'canceled',
    });

    const { res, run } = call();
    await run();

    expect(mockDelete).toHaveBeenCalledWith('sub-5');
    expect(res._getStatusCode()).toBe(200);
  });

  it('fails the request without notifying when the audit write fails', async () => {
    mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));

    const { res, run } = call();
    await expect(run()).rejects.toThrow('audit down');

    expect(mockSendToClient).not.toHaveBeenCalled();
    expect(res._getData()).toBe('');
  });
});
