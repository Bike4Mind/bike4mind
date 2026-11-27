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
// The gate (verifyOrgPermission) runs for real; it reads the org through the /infra entry, and its
// resolveActiveOrg import pulls the non-/infra barrel.
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockOrgFindById(...args) },
}));
vi.mock('@bike4mind/database', () => ({ organizationRepository: {} }));

const mockFindActiveSubscriptions = vi.fn();
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: {
    findActiveSubscriptionsByOwner: (...args: unknown[]) => mockFindActiveSubscriptions(...args),
  },
}));

const mockResolveSource = vi.fn();
vi.mock('@bike4mind/server-utils/services/organizationService', () => ({
  countPendingOrganizationInvites: vi.fn().mockResolvedValue(0),
  validateSeatChange: vi.fn(),
  resolveSubscriptionSource: (...args: unknown[]) => mockResolveSource(...args),
}));
vi.mock('@bike4mind/server-utils/services/teamPlanSettings', () => ({
  assertSeatsWithinPlan: vi.fn(),
  getTeamPlanSettings: vi.fn().mockResolvedValue({ minSeats: 1 }),
}));

const mockSubscriptionsList = vi.fn();
const mockSubscriptionsUpdate = vi.fn();
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: {
    subscriptions: {
      list: (...args: unknown[]) => mockSubscriptionsList(...args),
      update: (...args: unknown[]) => mockSubscriptionsUpdate(...args),
    },
  },
}));
vi.mock('@bike4mind/server-utils/utils/organizationAudit', () => ({
  recordOrganizationAuditEventSafe: vi.fn().mockResolvedValue(undefined),
}));

import handler from '../update-seats';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const ORG_ID = '507f1f77bcf86cd7994390a2';
const MISSING_ORG_ID = '507f1f77bcf86cd7994390ff';
const OWNER = '650000000000000000000111';
const BILLING_MANAGER = '650000000000000000000222';
const MANAGER = '650000000000000000000333';
const MEMBER = '650000000000000000000444';
const OUTSIDER = '650000000000000000000555';

const run = async (user: Record<string, unknown>, organizationId = ORG_ID) => {
  const { req, res } = createMocks({ method: 'POST' });
  (req as unknown as Record<string, unknown>).body = { organizationId, seats: 5 };
  (req as unknown as Record<string, unknown>).user = user;
  return (handler as unknown as HandlerFn)(req, res).then(
    () => ({ res, error: undefined }),
    (error: unknown) => ({ res, error })
  );
};

const org = {
  id: ORG_ID,
  userId: OWNER,
  adminUserIds: [MANAGER],
  billingManagerUserIds: [BILLING_MANAGER],
  users: [{ userId: MANAGER }, { userId: BILLING_MANAGER }, { userId: MEMBER }],
  stripeCustomerId: 'cus_org',
};

describe('POST /api/organizations/subscriptions/update-seats - manageBilling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindById.mockImplementation(async (id: string) => (id === ORG_ID ? org : null));
    mockFindActiveSubscriptions.mockResolvedValue([{ id: 'sub_1' }]);
    mockResolveSource.mockReturnValue('stripe');
    mockSubscriptionsList.mockResolvedValue({
      data: [{ id: 'sub_1', items: { data: [{ id: 'si_1', quantity: 3 }] } }],
    });
    mockSubscriptionsUpdate.mockResolvedValue({
      currency: 'usd',
      items: { data: [{ quantity: 5, current_period_end: 1_800_000_000, price: { unit_amount: 1000 } }] },
    });
  });

  it.each([
    ['the owner', { id: OWNER, isAdmin: false }],
    ['a billing manager', { id: BILLING_MANAGER, isAdmin: false }],
    ['a platform admin who is not a member', { id: OUTSIDER, isAdmin: true }],
  ])('admits %s and updates the Stripe seats', async (_who, user) => {
    const { res, error } = await run(user);

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({ items: [{ id: 'si_1', quantity: 5 }] })
    );
  });

  it.each([
    ['a plain member', { id: MEMBER, isAdmin: false }, ORG_ID],
    ['a manager', { id: MANAGER, isAdmin: false }, ORG_ID],
    ['an outsider', { id: OUTSIDER, isAdmin: false }, ORG_ID],
    ['a nonexistent org', { id: OWNER, isAdmin: false }, MISSING_ORG_ID],
  ])('answers %s with the same 404 as a missing org and changes nothing', async (_who, user, orgId) => {
    const { error: missing } = await run({ id: OWNER, isAdmin: false }, MISSING_ORG_ID);
    const { error } = await run(user, orgId);

    expect(error).toMatchObject({ statusCode: 404, message: 'Organization not found' });
    expect(error).toEqual(missing);
    expect(mockSubscriptionsList).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });

  it('still refuses an admitted caller on an admin-granted org', async () => {
    mockResolveSource.mockReturnValue('admin_grant');

    const { error } = await run({ id: OWNER, isAdmin: false });

    expect(error).toMatchObject({ message: 'Contact support to enable billing for this organization.' });
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });
});
