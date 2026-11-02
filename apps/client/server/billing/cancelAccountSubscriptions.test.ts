import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findOrgs: vi.fn(),
  list: vi.fn(),
  cancel: vi.fn(),
  isStripeConfigured: vi.fn(),
  voidOpenSubscriptionInvoices: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mocks.findById },
  organizationRepository: { find: mocks.findOrgs },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  isStripeConfigured: mocks.isStripeConfigured,
  stripe: { subscriptions: { list: mocks.list, cancel: mocks.cancel } },
}));
vi.mock('@server/integrations/stripe/dunning', () => ({
  voidOpenSubscriptionInvoices: mocks.voidOpenSubscriptionInvoices,
}));

import { cancelAccountSubscriptions } from './cancelAccountSubscriptions';

const USER_ID = '665f1c2e8b3a4d0012345678';
const logger = { info: vi.fn(), error: vi.fn() };
const cancel = () => cancelAccountSubscriptions({ userId: USER_ID, reason: 'account_deletion_requested' }, logger);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isStripeConfigured.mockReturnValue(true);
  mocks.findById.mockResolvedValue({ id: USER_ID, stripeCustomerId: 'cus_user' });
  mocks.findOrgs.mockResolvedValue([{ stripeCustomerId: 'cus_org' }]);
  mocks.list.mockImplementation(async ({ customer }: { customer: string }) => ({
    data:
      customer === 'cus_user'
        ? [
            { id: 'sub_live', status: 'active' },
            { id: 'sub_done', status: 'canceled' },
          ]
        : [{ id: 'sub_org', status: 'past_due' }],
  }));
  mocks.cancel.mockResolvedValue({});
  mocks.voidOpenSubscriptionInvoices.mockResolvedValue(undefined);
});

describe('cancelAccountSubscriptions', () => {
  it('immediately cancels the live subscriptions of the user and their owned orgs', async () => {
    const result = await cancel();

    expect(result).toEqual({ canceled: ['sub_live', 'sub_org'], failed: [] });
    expect(mocks.cancel).toHaveBeenCalledWith('sub_live', {
      prorate: false,
      cancellation_details: { comment: expect.stringContaining('delete the account') },
    });
    expect(mocks.cancel).not.toHaveBeenCalledWith('sub_done', expect.anything());
    expect(mocks.voidOpenSubscriptionInvoices).toHaveBeenCalledWith('sub_live');
  });

  it('reports a failed cancel without throwing, and carries on with the rest', async () => {
    mocks.cancel.mockImplementation(async (id: string) => {
      if (id === 'sub_live') throw Object.assign(new Error('nope'), { code: 'resource_missing' });
      return {};
    });

    const result = await cancel();

    expect(result.canceled).toEqual(['sub_org']);
    expect(result.failed).toEqual([{ customerId: 'cus_user', subscriptionId: 'sub_live', reason: 'resource_missing' }]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('does nothing when Stripe is not configured', async () => {
    mocks.isStripeConfigured.mockReturnValue(false);
    await expect(cancel()).resolves.toEqual({ canceled: [], failed: [] });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
