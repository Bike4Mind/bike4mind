import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findActiveUserSubscriptions, findActiveSubscriptionsByOwners } = vi.hoisted(() => ({
  findActiveUserSubscriptions: vi.fn(),
  findActiveSubscriptionsByOwners: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findActiveUserSubscriptions, findActiveSubscriptionsByOwners },
}));

const { findPlanHolderOrgIds, findMembershipOrgIds } = vi.hoisted(() => ({
  findPlanHolderOrgIds: vi.fn(),
  findMembershipOrgIds: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ organizationRepository: { findPlanHolderOrgIds, findMembershipOrgIds } }));

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: { warn } } }));

import {
  activePlanResolver,
  getActiveSubscriptionsForUser,
  getRequestActiveSubscriptions,
} from './activeSubscriptions';

const own = { priceId: 'price_pro', ownerType: 'User', ownerId: 'u1' };
const seat = { priceId: 'price_team', ownerType: 'Organization', ownerId: 'org1' };

describe('activePlanResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findActiveUserSubscriptions.mockResolvedValue([]);
    findActiveSubscriptionsByOwners.mockResolvedValue([]);
    findPlanHolderOrgIds.mockResolvedValue([]);
  });

  it('reports no plan only after the user and org reads succeed', async () => {
    await expect(activePlanResolver.hasActivePlan('u1')).resolves.toBe(false);
    expect(findActiveUserSubscriptions).toHaveBeenCalledWith('u1');
    expect(findPlanHolderOrgIds).toHaveBeenCalledWith('u1');
    expect(findActiveSubscriptionsByOwners).not.toHaveBeenCalled();
  });

  it('recognizes a user-owned plan without needing the org leg', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);

    await expect(activePlanResolver.hasActivePlan('u1')).resolves.toBe(true);
    expect(findPlanHolderOrgIds).not.toHaveBeenCalled();
  });

  it('recognizes an org seat even when the user has no personal plan', async () => {
    findPlanHolderOrgIds.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwners.mockResolvedValue([seat]);

    await expect(activePlanResolver.hasActivePlan('u1')).resolves.toBe(true);
    expect(findActiveSubscriptionsByOwners).toHaveBeenCalledWith('Organization', ['org1']);
  });

  it('does not classify a failed membership read as no active plan', async () => {
    const error = new Error('membership lookup unavailable');
    findPlanHolderOrgIds.mockRejectedValue(error);

    await expect(activePlanResolver.hasActivePlan('u1')).rejects.toBe(error);
  });

  it('does not classify a failed org-subscription read as no active plan', async () => {
    const error = new Error('org subscriptions unavailable');
    findPlanHolderOrgIds.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwners.mockRejectedValue(error);

    await expect(activePlanResolver.hasActivePlan('u1')).rejects.toBe(error);
  });

  it('propagates a failed user-owned subscription read', async () => {
    const error = new Error('user subscriptions unavailable');
    findActiveUserSubscriptions.mockRejectedValue(error);

    await expect(activePlanResolver.hasActivePlan('u1')).rejects.toBe(error);
  });
});

describe('getActiveSubscriptionsForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findActiveUserSubscriptions.mockResolvedValue([]);
    findActiveSubscriptionsByOwners.mockResolvedValue([]);
    findPlanHolderOrgIds.mockResolvedValue([]);
  });

  it('returns only the user rows and skips the org read when the user has no memberships', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);

    await expect(getActiveSubscriptionsForUser('u1')).resolves.toEqual([own]);
    expect(findActiveSubscriptionsByOwners).not.toHaveBeenCalled();
  });

  it('merges the user rows with the org rows of every membership', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);
    findPlanHolderOrgIds.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwners.mockResolvedValue([seat]);

    await expect(getActiveSubscriptionsForUser('u1')).resolves.toEqual([own, seat]);
    expect(findActiveSubscriptionsByOwners).toHaveBeenCalledWith('Organization', ['org1']);
  });

  // Degrading to the user's own rows under-grants a seat member for one request (the pre-seat
  // behavior); failing would take every gated route and /me down for every org member.
  it('degrades to the user rows and logs when the org-subscription read fails', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);
    findPlanHolderOrgIds.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwners.mockRejectedValue(new Error('mongo unavailable'));

    await expect(getActiveSubscriptionsForUser('u1')).resolves.toEqual([own]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('degrades to the user rows when the plan-holder lookup fails', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);
    findPlanHolderOrgIds.mockRejectedValue(new Error('mongo unavailable'));

    await expect(getActiveSubscriptionsForUser('u1')).resolves.toEqual([own]);
    expect(findActiveSubscriptionsByOwners).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('strict access reads propagate membership lookup failures even for personal subscribers', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);
    findPlanHolderOrgIds.mockRejectedValue(new Error('membership down'));

    await expect(getActiveSubscriptionsForUser('u1', { strict: true })).rejects.toThrow('membership down');
    expect(warn).not.toHaveBeenCalled();
  });

  it('strict access reads propagate org subscription failures even for a personal subscriber', async () => {
    findActiveUserSubscriptions.mockResolvedValue([own]);
    findPlanHolderOrgIds.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwners.mockRejectedValue(new Error('org subscriptions down'));

    await expect(getActiveSubscriptionsForUser('u1', { strict: true })).rejects.toThrow('org subscriptions down');
    expect(warn).not.toHaveBeenCalled();
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
    findPlanHolderOrgIds.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwners.mockResolvedValue([seat]);
  });

  it('memoizes the rows on the request, so later callers pay no reads', async () => {
    const req: { user: never; activeSubscriptions?: unknown } = { user };

    const first = await getRequestActiveSubscriptions(req);
    const second = await getRequestActiveSubscriptions(req);

    expect(first).toEqual([own, seat]);
    expect(second).toBe(first);
    expect(findActiveUserSubscriptions).toHaveBeenCalledTimes(1);
    expect(findPlanHolderOrgIds).toHaveBeenCalledTimes(1);
    expect(findActiveSubscriptionsByOwners).toHaveBeenCalledTimes(1);
  });

  it('an org admin without a member row resolves to the org plan', async () => {
    findActiveUserSubscriptions.mockResolvedValue([]);
    findPlanHolderOrgIds.mockResolvedValue(['adminOrg']);
    findMembershipOrgIds.mockResolvedValue([]);
    findActiveSubscriptionsByOwners.mockResolvedValue([{ ...seat, ownerId: 'adminOrg' }]);

    await expect(getRequestActiveSubscriptions({ user })).resolves.toEqual([{ ...seat, ownerId: 'adminOrg' }]);
    expect(findActiveSubscriptionsByOwners).toHaveBeenCalledWith('Organization', ['adminOrg']);
  });

  it('refreshes a degraded request memo before a strict lookup', async () => {
    findActiveUserSubscriptions.mockResolvedValue([]);
    findPlanHolderOrgIds.mockRejectedValueOnce(new Error('membership down'));
    const req = { user };

    await expect(getRequestActiveSubscriptions(req)).resolves.toEqual([]);
    await expect(getRequestActiveSubscriptions(req, { strict: true })).resolves.toEqual([seat]);
    await expect(getRequestActiveSubscriptions(req, { strict: true })).resolves.toEqual([seat]);
    expect(findPlanHolderOrgIds).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a degraded memo when the strict retry also fails', async () => {
    findActiveUserSubscriptions.mockResolvedValue([]);
    const error = new Error('membership down');
    findPlanHolderOrgIds.mockRejectedValue(error);
    const req = { user };

    await expect(getRequestActiveSubscriptions(req)).resolves.toEqual([]);
    await expect(getRequestActiveSubscriptions(req, { strict: true })).rejects.toBe(error);
    expect(findPlanHolderOrgIds).toHaveBeenCalledTimes(2);
  });

  it('manager and admin orgs do not widen request membership', async () => {
    findPlanHolderOrgIds.mockResolvedValue(['org1', 'managedOrg', 'adminOrg']);
    const req: { user: never; membershipOrgIds?: string[]; activeSubscriptions?: unknown } = { user };

    await getRequestActiveSubscriptions(req);

    expect(req.membershipOrgIds).toBeUndefined();
    expect(findMembershipOrgIds).not.toHaveBeenCalled();
  });

  it('returns [] without reading for an unauthenticated request', async () => {
    await expect(getRequestActiveSubscriptions({})).resolves.toEqual([]);
    expect(findActiveUserSubscriptions).not.toHaveBeenCalled();
  });
});
