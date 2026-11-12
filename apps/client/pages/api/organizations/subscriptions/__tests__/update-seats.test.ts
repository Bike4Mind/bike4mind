// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: function () {
      return this;
    },
    post: (fn: unknown) => fn,
  }),
}));
vi.mock('@server/middlewares/requireStripeWebhook', () => ({ requireStripeWebhook: () => vi.fn() }));
vi.mock('@server/middlewares/refuseBlockedAccount', () => ({ refuseBlockedAccount: () => vi.fn() }));

const mockOrgFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockOrgFindById(...args) },
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findActiveSubscriptionsByOwner: vi.fn().mockResolvedValue([{ id: 'sub_1' }]) },
}));
// Every org here is admin-granted, so a caller who passes the permission guard stops at this refusal.
vi.mock('@bike4mind/server-utils/services/organizationService', () => ({
  countPendingOrganizationInvites: vi.fn(),
  validateSeatChange: vi.fn(),
  resolveSubscriptionSource: () => 'admin_grant',
}));
vi.mock('@bike4mind/server-utils/services/teamPlanSettings', () => ({
  assertSeatsWithinPlan: vi.fn(),
  getTeamPlanSettings: vi.fn().mockResolvedValue({ minSeats: 1 }),
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({ stripe: {} }));

import handler from '../update-seats';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const ORG_ID = '507f1f77bcf86cd7994390a2';

const run = (user: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST' });
  (req as unknown as Record<string, unknown>).body = { organizationId: ORG_ID, seats: 5 };
  (req as unknown as Record<string, unknown>).user = user;
  return (handler as unknown as HandlerFn)(req, res);
};

const NOT_AUTHORIZED = 'Not authorized to change seats for this organization';
const PAST_GUARD = 'Contact support to enable billing for this organization.';

describe('POST /api/organizations/subscriptions/update-seats - manageBilling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindById.mockResolvedValue({
      id: ORG_ID,
      userId: 'owner_1',
      adminUserIds: ['manager_1'],
      billingManagerUserIds: ['billing_1'],
      users: [{ userId: 'manager_1' }, { userId: 'billing_1' }, { userId: 'member_1' }],
    });
  });

  it.each([
    ['the owner', { id: 'owner_1' }],
    ['a billing manager', { id: 'billing_1' }],
    ['a platform admin', { id: 'stranger_1', isAdmin: true }],
  ])('admits %s', async (_who, user) => {
    await expect(run(user)).rejects.toThrow(PAST_GUARD);
  });

  it.each([
    ['a manager', { id: 'manager_1' }],
    ['a plain member', { id: 'member_1' }],
    ['an outsider', { id: 'stranger_1' }],
  ])('refuses %s', async (_who, user) => {
    await expect(run(user)).rejects.toThrow(NOT_AUTHORIZED);
  });
});
