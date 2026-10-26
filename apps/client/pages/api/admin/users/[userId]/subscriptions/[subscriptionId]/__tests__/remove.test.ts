import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
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

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

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
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...a: unknown[]) => {
    insideTransactionAtAudit = inTransaction;
    return mockRecordAdminAction(...a);
  },
}));

const mockSendToClient = vi.fn();
vi.mock('@server/websocket/utils', () => ({ sendToClient: (...a: unknown[]) => mockSendToClient(...a) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import handler from '../remove';

function call() {
  const { req, res } = createMocks({ method: 'DELETE', query: { userId: 'u1', subscriptionId: 'sub_123' } });
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

  it('fails the request without notifying when the audit write fails', async () => {
    mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));

    const { res, run } = call();
    await expect(run()).rejects.toThrow('audit down');

    expect(mockSendToClient).not.toHaveBeenCalled();
    expect(res._getData()).toBe('');
  });
});
