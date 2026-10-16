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

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: { warn } } }));

import { getActiveSubscriptionsForUser, getRequestActiveSubscriptions } from './activeSubscriptions';

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

  it('uses the supplied membership resolver instead of reading membership itself', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);

    await expect(getActiveSubscriptionsForUser('u1', { membershipOrgIds: async () => [] })).resolves.toEqual([own]);
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

  // Degrading to the user's own rows under-grants a seat member for one request (the pre-seat
  // behavior); failing would take every gated route and /me down for every org member.
  it('degrades to the user rows and logs when the org-subscription read fails', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);
    findMembershipOrgIds.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwners.mockRejectedValue(new Error('mongo unavailable'));

    await expect(getActiveSubscriptionsForUser('u1')).resolves.toEqual([own]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('degrades to the user rows when the membership resolver fails', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);

    await expect(
      getActiveSubscriptionsForUser('u1', { membershipOrgIds: () => Promise.reject(new Error('mongo unavailable')) })
    ).resolves.toEqual([own]);
    expect(findActiveSubscriptionsByOwners).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still fails when the user-owned read fails (nothing to degrade to)', async () => {
    findActiveUserSubscriptions.mockRejectedValue(new Error('mongo unavailable'));

    await expect(getActiveSubscriptionsForUser('u1')).rejects.toThrow('mongo unavailable');
  });
});

describe('getRequestActiveSubscriptions', () => {
  const user = { id: 'u1' } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    findActiveUserSubscriptions.mockResolvedValue([own]);
    findMembershipOrgIds.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwners.mockResolvedValue([seat]);
  });

  it('memoizes the rows and the membership on the request, so later callers pay no reads', async () => {
    const req: { user: never; membershipOrgIds?: string[]; activeSubscriptions?: unknown } = { user };

    const first = await getRequestActiveSubscriptions(req);
    const second = await getRequestActiveSubscriptions(req);

    expect(first).toEqual([own, seat]);
    expect(second).toBe(first);
    expect(req.membershipOrgIds).toEqual(['org1']);
    expect(findActiveUserSubscriptions).toHaveBeenCalledTimes(1);
    expect(findMembershipOrgIds).toHaveBeenCalledTimes(1);
    expect(findActiveSubscriptionsByOwners).toHaveBeenCalledTimes(1);
  });

  it('reuses an already-resolved membership memo', async () => {
    await getRequestActiveSubscriptions({ user, membershipOrgIds: ['org2'] });

    expect(findMembershipOrgIds).not.toHaveBeenCalled();
    expect(findActiveSubscriptionsByOwners).toHaveBeenCalledWith('Organization', ['org2']);
  });

  it('returns [] without reading for an unauthenticated request', async () => {
    await expect(getRequestActiveSubscriptions({})).resolves.toEqual([]);
    expect(findActiveUserSubscriptions).not.toHaveBeenCalled();
  });
});
