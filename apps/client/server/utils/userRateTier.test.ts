import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked collaborators. isDevelopment defaults to false so tier logic is exercised;
// individual tests flip it. SUBSCRIPTION_PLANS_MAP is mocked with stable test
// priceIds (the real map's ids come from per-stage env vars). tier values mirror
// UserSubscriptionTier - Basic = 1, Pro = 2.
const {
  isDevelopmentMock,
  findActiveUserSubscriptionsMock,
  findActiveSubscriptionsByOwnersMock,
  findPlanHolderOrgIdsMock,
  getSettingsMapMock,
  getSettingsValueMock,
} = vi.hoisted(() => ({
  isDevelopmentMock: vi.fn<() => boolean>(() => false),
  findActiveUserSubscriptionsMock: vi.fn<(userId: string) => Promise<{ priceId: string }[]>>(),
  findActiveSubscriptionsByOwnersMock:
    vi.fn<(ownerType: string, ownerIds: readonly string[]) => Promise<{ priceId: string }[]>>(),
  findPlanHolderOrgIdsMock: vi.fn<(userId: string) => Promise<string[]>>(),
  getSettingsMapMock: vi.fn(async () => ({}) as Record<string, string>),
  getSettingsValueMock: vi.fn<(key: string, settings: Record<string, string>) => number>(),
}));

vi.mock('@server/utils/config', () => ({ isDevelopment: () => isDevelopmentMock() }));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findActiveUserSubscriptions: findActiveUserSubscriptionsMock,
    findActiveSubscriptionsByOwners: findActiveSubscriptionsByOwnersMock,
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  organizationRepository: { findPlanHolderOrgIds: findPlanHolderOrgIdsMock },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...args: unknown[]) => getSettingsMapMock(...(args as [])),
  getSettingsValue: (key: string, settings: Record<string, string>) => getSettingsValueMock(key, settings),
}));
vi.mock('@client/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS: [],
  SUBSCRIPTION_PLANS_MAP: {
    price_basic: { tier: 1 },
    price_pro: { tier: 2 },
    price_standalone: {}, // standalone single-product plan - no ladder tier
  },
  TEAM_PLAN: { priceId: 'price_team', tier: 2 },
}));

import { resolveUserRateTier, resolveUserRateLimitPerMin } from './userRateTier';

const TIER_LIMITS: Record<string, number> = {
  apiRateLimitFreePerMin: 10,
  apiRateLimitBasicPerMin: 30,
  apiRateLimitProPerMin: 60,
};

describe('resolveUserRateTier', () => {
  beforeEach(() => {
    isDevelopmentMock.mockReturnValue(false);
    findActiveUserSubscriptionsMock.mockReset();
    findActiveUserSubscriptionsMock.mockResolvedValue([]);
    findActiveSubscriptionsByOwnersMock.mockReset();
    findActiveSubscriptionsByOwnersMock.mockResolvedValue([]);
    findPlanHolderOrgIdsMock.mockReset();
    findPlanHolderOrgIdsMock.mockResolvedValue([]);
  });

  it('bypasses for admins without reading org subscriptions', async () => {
    expect(await resolveUserRateTier({ id: 'u1', isAdmin: true })).toBe('bypass');
    expect(findActiveUserSubscriptionsMock).not.toHaveBeenCalled();
    expect(findPlanHolderOrgIdsMock).not.toHaveBeenCalled();
    expect(findActiveSubscriptionsByOwnersMock).not.toHaveBeenCalled();
  });

  it('returns "bypass" for developer-tagged users', async () => {
    expect(await resolveUserRateTier({ id: 'u1', tags: ['developer'] })).toBe('bypass');
    expect(findActiveUserSubscriptionsMock).not.toHaveBeenCalled();
  });

  it('returns "free" for an authenticated user with no active subscriptions', async () => {
    findActiveUserSubscriptionsMock.mockResolvedValue([]);
    expect(await resolveUserRateTier({ id: 'u1' })).toBe('free');
  });

  it('returns "basic" for a Basic-tier subscription', async () => {
    findActiveUserSubscriptionsMock.mockResolvedValue([{ priceId: 'price_basic' }]);
    expect(await resolveUserRateTier({ id: 'u1' })).toBe('basic');
  });

  it('returns "pro" for a Pro-tier subscription', async () => {
    findActiveUserSubscriptionsMock.mockResolvedValue([{ priceId: 'price_pro' }]);
    expect(await resolveUserRateTier({ id: 'u1' })).toBe('pro');
  });

  it('takes the HIGHEST tier when a user holds multiple active subscriptions', async () => {
    findActiveUserSubscriptionsMock.mockResolvedValue([{ priceId: 'price_basic' }, { priceId: 'price_pro' }]);
    expect(await resolveUserRateTier({ id: 'u1' })).toBe('pro');
  });

  it('resolves an org seat member to the Pro tier', async () => {
    findPlanHolderOrgIdsMock.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwnersMock.mockResolvedValue([{ priceId: 'price_team' }]);
    expect(await resolveUserRateTier({ id: 'u1' })).toBe('pro');
    expect(findActiveSubscriptionsByOwnersMock).toHaveBeenCalledWith('Organization', ['org1']);
  });

  it('does not grant org plan tier to a user outside the org', async () => {
    findPlanHolderOrgIdsMock.mockResolvedValue([]);
    expect(await resolveUserRateTier({ id: 'u1' })).toBe('free');
    expect(findActiveSubscriptionsByOwnersMock).not.toHaveBeenCalled();
  });

  it('takes the highest tier across user-owned and org-owned subscriptions', async () => {
    findActiveUserSubscriptionsMock.mockResolvedValue([{ priceId: 'price_basic' }]);
    findPlanHolderOrgIdsMock.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwnersMock.mockResolvedValue([{ priceId: 'price_team' }]);
    expect(await resolveUserRateTier({ id: 'u1' })).toBe('pro');
  });

  // The repository's active-only predicate is pinned by Subscription.e2e.test.ts; here an org
  // whose plan has lapsed simply contributes no rows.
  it('ignores inactive org subscriptions', async () => {
    findActiveUserSubscriptionsMock.mockResolvedValue([{ priceId: 'price_basic' }]);
    findPlanHolderOrgIdsMock.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwnersMock.mockResolvedValue([]);
    expect(await resolveUserRateTier({ id: 'u1' })).toBe('basic');
  });

  it('treats tier-less standalone plans as "free" (not on the ladder)', async () => {
    findActiveUserSubscriptionsMock.mockResolvedValue([{ priceId: 'price_standalone' }]);
    expect(await resolveUserRateTier({ id: 'u1' })).toBe('free');
  });
});

describe('resolveUserRateLimitPerMin', () => {
  beforeEach(() => {
    isDevelopmentMock.mockReturnValue(false);
    findActiveUserSubscriptionsMock.mockReset();
    findActiveUserSubscriptionsMock.mockResolvedValue([]);
    findActiveSubscriptionsByOwnersMock.mockReset();
    findActiveSubscriptionsByOwnersMock.mockResolvedValue([]);
    findPlanHolderOrgIdsMock.mockReset();
    findPlanHolderOrgIdsMock.mockResolvedValue([]);
    getSettingsValueMock.mockReset();
    getSettingsValueMock.mockImplementation((key: string) => TIER_LIMITS[key]);
  });

  it('returns Infinity (no enforcement) on the dev server without touching settings', async () => {
    isDevelopmentMock.mockReturnValue(true);
    expect(await resolveUserRateLimitPerMin({ id: 'u1' })).toBe(Infinity);
    expect(getSettingsValueMock).not.toHaveBeenCalled();
    expect(findActiveUserSubscriptionsMock).not.toHaveBeenCalled();
  });

  it('fails closed to the Free-tier floor when no user is present (unreachable post-auth)', async () => {
    expect(await resolveUserRateLimitPerMin(undefined)).toBe(10);
    expect(findActiveUserSubscriptionsMock).not.toHaveBeenCalled();
  });

  it('returns Infinity for bypass tiers (admins) without reading settings', async () => {
    expect(await resolveUserRateLimitPerMin({ id: 'u1', isAdmin: true })).toBe(Infinity);
    expect(getSettingsValueMock).not.toHaveBeenCalled();
  });

  it('falls back to the free floor when org resolution throws', async () => {
    findPlanHolderOrgIdsMock.mockRejectedValue(new Error('mongo unavailable'));
    expect(await resolveUserRateLimitPerMin({ id: 'u1' })).toBe(10);
  });

  it('falls back to the free floor when the org subscription read throws', async () => {
    findPlanHolderOrgIdsMock.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwnersMock.mockRejectedValue(new Error('mongo unavailable'));
    expect(await resolveUserRateLimitPerMin({ id: 'u1' })).toBe(10);
  });

  // The org leg degrades to the user's own rows, so a personal subscriber keeps their own tier.
  it("keeps the user's own tier when org resolution throws", async () => {
    findActiveUserSubscriptionsMock.mockResolvedValue([{ priceId: 'price_pro' }]);
    findPlanHolderOrgIdsMock.mockRejectedValue(new Error('mongo unavailable'));
    expect(await resolveUserRateLimitPerMin({ id: 'u1' })).toBe(TIER_LIMITS.apiRateLimitProPerMin);
  });

  it('resolves through the request memo, leaving the reads for the handler to reuse', async () => {
    findPlanHolderOrgIdsMock.mockResolvedValue(['org1']);
    findActiveSubscriptionsByOwnersMock.mockResolvedValue([{ priceId: 'price_team' }]);
    const user = { id: 'u1' };
    const req: { user: never; membershipOrgIds?: string[]; activeSubscriptions?: unknown[] } = {
      user: user as never,
    };

    expect(await resolveUserRateLimitPerMin(user, req)).toBe(TIER_LIMITS.apiRateLimitProPerMin);
    expect(req.membershipOrgIds).toBeUndefined();
    expect(req.activeSubscriptions).toEqual([{ priceId: 'price_team' }]);

    await resolveUserRateLimitPerMin(user, req);
    expect(findActiveUserSubscriptionsMock).toHaveBeenCalledTimes(1);
    expect(findPlanHolderOrgIdsMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed to the Free-tier floor when subscription resolution throws (no 500)', async () => {
    findActiveUserSubscriptionsMock.mockRejectedValue(new Error('mongo unavailable'));
    expect(await resolveUserRateLimitPerMin({ id: 'u1' })).toBe(10);
  });

  it('reads the Free-tier setting for an unsubscribed user', async () => {
    expect(await resolveUserRateLimitPerMin({ id: 'u1' })).toBe(10);
    expect(getSettingsValueMock).toHaveBeenCalledWith('apiRateLimitFreePerMin', expect.anything());
  });

  it('reads the Basic-tier setting for a Basic subscriber', async () => {
    findActiveUserSubscriptionsMock.mockResolvedValue([{ priceId: 'price_basic' }]);
    expect(await resolveUserRateLimitPerMin({ id: 'u1' })).toBe(30);
    expect(getSettingsValueMock).toHaveBeenCalledWith('apiRateLimitBasicPerMin', expect.anything());
  });

  it('reads the Pro-tier setting for a Pro subscriber', async () => {
    findActiveUserSubscriptionsMock.mockResolvedValue([{ priceId: 'price_pro' }]);
    expect(await resolveUserRateLimitPerMin({ id: 'u1' })).toBe(60);
    expect(getSettingsValueMock).toHaveBeenCalledWith('apiRateLimitProPerMin', expect.anything());
  });
});
