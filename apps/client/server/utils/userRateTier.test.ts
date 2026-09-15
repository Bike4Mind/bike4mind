import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked collaborators. isDevelopment defaults to false so tier logic is exercised;
// individual tests flip it. SUBSCRIPTION_PLANS_MAP is mocked with stable test
// priceIds (the real map's ids come from per-stage env vars). tier values mirror
// UserSubscriptionTier - Basic = 1, Pro = 2.
const { isDevelopmentMock, findActiveUserSubscriptionsMock, getSettingsMapMock, getSettingsValueMock } = vi.hoisted(
  () => ({
    isDevelopmentMock: vi.fn<() => boolean>(() => false),
    findActiveUserSubscriptionsMock: vi.fn<(userId: string) => Promise<{ priceId: string }[]>>(),
    getSettingsMapMock: vi.fn(async () => ({}) as Record<string, string>),
    getSettingsValueMock: vi.fn<(key: string, settings: Record<string, string>) => number>(),
  })
);

vi.mock('@server/utils/config', () => ({ isDevelopment: () => isDevelopmentMock() }));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findActiveUserSubscriptions: findActiveUserSubscriptionsMock },
}));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...args: unknown[]) => getSettingsMapMock(...(args as [])),
  getSettingsValue: (key: string, settings: Record<string, string>) => getSettingsValueMock(key, settings),
}));
vi.mock('@client/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS_MAP: {
    price_basic: { tier: 1 },
    price_pro: { tier: 2 },
    price_standalone: {}, // standalone single-product plan - no ladder tier
  },
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
  });

  it('returns "bypass" for admins without reading subscriptions', async () => {
    expect(await resolveUserRateTier({ id: 'u1', isAdmin: true })).toBe('bypass');
    expect(findActiveUserSubscriptionsMock).not.toHaveBeenCalled();
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
