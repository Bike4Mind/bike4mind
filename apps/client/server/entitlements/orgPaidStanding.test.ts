import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findActiveSubscriptionsByOwners: vi.fn(),
}));

vi.mock('@client/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS: [],
  SUBSCRIPTION_PLANS_MAP: { price_basic: { tier: 1 } },
  TEAM_PLAN: { priceId: 'price_team', tier: 2 },
}));
vi.mock('@bike4mind/database', () => ({ organizationRepository: { findById: mocks.findById } }));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findActiveSubscriptionsByOwners: mocks.findActiveSubscriptionsByOwners },
}));

import { isPayingOrganization } from './orgPaidStanding';

describe('isPayingOrganization', () => {
  beforeEach(() => {
    mocks.findById.mockReset().mockResolvedValue({ id: 'org1' });
    mocks.findActiveSubscriptionsByOwners.mockReset().mockResolvedValue([]);
  });

  it('is true for an active paid subscription the organization owns', async () => {
    mocks.findActiveSubscriptionsByOwners.mockResolvedValue([{ priceId: 'price_team' }]);
    expect(await isPayingOrganization('org1')).toBe(true);
    expect(mocks.findActiveSubscriptionsByOwners).toHaveBeenCalledWith('Organization', ['org1']);
  });

  it('is true for a credit purchase stamped on the organization', async () => {
    mocks.findById.mockResolvedValue({ id: 'org1', lastCreditsPurchasedAt: new Date() });
    expect(await isPayingOrganization('org1')).toBe(true);
  });

  it('is false with neither, with an unknown price id, or for a missing organization', async () => {
    expect(await isPayingOrganization('org1')).toBe(false);
    mocks.findActiveSubscriptionsByOwners.mockResolvedValue([{ priceId: 'price_unknown' }]);
    expect(await isPayingOrganization('org1')).toBe(false);
    mocks.findById.mockResolvedValue(null);
    expect(await isPayingOrganization('org1')).toBe(false);
  });

  it('propagates a read error', async () => {
    mocks.findActiveSubscriptionsByOwners.mockRejectedValue(new Error('db down'));
    await expect(isPayingOrganization('org1')).rejects.toThrow('db down');
  });
});
