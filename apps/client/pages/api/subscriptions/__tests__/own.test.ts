import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;
const mockRefs = vi.hoisted(() => ({ getHandler: null as Handler | null }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (fn: Handler) => {
      mockRefs.getHandler = fn;
      return fn;
    },
  }),
}));

const findAllUserSubscriptions = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findAllUserSubscriptions },
}));

import '@pages/api/subscriptions/own';

describe('GET /api/subscriptions/own', () => {
  beforeEach(() => findAllUserSubscriptions.mockReset());

  it('returns the caller subscription history with customer-facing fields only', async () => {
    findAllUserSubscriptions.mockResolvedValueOnce([
      {
        id: 'sub1',
        ownerType: 'User',
        ownerId: 'u1',
        subscriptionId: 'sub_1',
        priceId: 'price_pro',
        status: 'active',
        source: 'admin_grant',
        canceledAt: null,
        periodStartsAt: new Date('2026-01-01'),
        periodEndsAt: new Date('2026-02-01'),
        grantedBy: 'admin1',
        grantedReason: 'comp',
        stripeCustomerId: 'cus_1',
        billingNoticeKeys: ['unpaid:sub_1'],
        acquisition: { first: { source: 'ad' } },
      },
    ]);

    const { req, res } = createMocks({ method: 'GET' });
    (req as unknown as { user: unknown }).user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);

    const [row] = res._getJSONData();
    expect(row).toMatchObject({
      id: 'sub1',
      userId: 'u1',
      priceId: 'price_pro',
      status: 'active',
      source: 'admin_grant',
    });
    for (const key of [
      'ownerId',
      'ownerType',
      'grantedBy',
      'grantedReason',
      'stripeCustomerId',
      'billingNoticeKeys',
      'acquisition',
    ]) {
      expect(row).not.toHaveProperty(key);
    }
    expect(findAllUserSubscriptions).toHaveBeenCalledWith('u1');
  });
});
