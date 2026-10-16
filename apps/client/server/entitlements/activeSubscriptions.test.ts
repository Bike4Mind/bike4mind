import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findActiveUserSubscriptions, findActiveSubscriptionsByOwners } = vi.hoisted(() => ({
  findActiveUserSubscriptions: vi.fn(),
  findActiveSubscriptionsByOwners: vi.fn(),
}));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findActiveUserSubscriptions, findActiveSubscriptionsByOwners },
}));

const { findMembershipOrgIds } = vi.hoisted(() => ({ findMembershipOrgIds: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ organizationRepository: { findMembershipOrgIds } }));

import { getActiveSubscriptionsForUser } from './activeSubscriptions';

const own = { priceId: 'price_pro', ownerType: 'User', ownerId: 'u1' };
const seat = { priceId: 'price_team', ownerType: 'Organization', ownerId: 'org1' };

describe('getActiveSubscriptionsForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findActiveUserSubscriptions.mockResolvedValue([]);
    findActiveSubscriptionsByOwners.mockResolvedValue([]);
    findMembershipOrgIds.mockResolvedValue([]);
  });

  it('returns only the user rows and skips the org read when the user has no memberships', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);

    await expect(getActiveSubscriptionsForUser('u1')).resolves.toEqual([own]);
    expect(findActiveSubscriptionsByOwners).not.toHaveBeenCalled();
  });

  it('treats a precomputed empty membership list as authoritative (no membership or org read)', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);

    await expect(getActiveSubscriptionsForUser('u1', { membershipOrgIds: [] })).resolves.toEqual([own]);
    expect(findMembershipOrgIds).not.toHaveBeenCalled();
    expect(findActiveSubscriptionsByOwners).not.toHaveBeenCalled();
  });

  it('merges the user rows with the org rows of every membership', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);
    findMembershipOrgIds.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwners.mockResolvedValue([seat]);

    await expect(getActiveSubscriptionsForUser('u1')).resolves.toEqual([own, seat]);
    expect(findActiveSubscriptionsByOwners).toHaveBeenCalledWith('Organization', ['org1']);
  });

  it('propagates an org-subscription read failure rather than dropping to the user rows', async () => {
    findMembershipOrgIds.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwners.mockRejectedValue(new Error('mongo unavailable'));

    await expect(getActiveSubscriptionsForUser('u1')).rejects.toThrow('mongo unavailable');
  });
});
