// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindById, mockFindByStripeCustomerId, mockPlan } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindByStripeCustomerId: vi.fn(),
  mockPlan: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mockFindById, findByStripeCustomerId: mockFindByStripeCustomerId },
}));
vi.mock('@client/lib/userSubscriptions/utils', () => ({ getEntitlingPlanByPriceId: mockPlan }));

import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  creditBuyerForEvents,
  planChangeDirection,
  planDetails,
  subscriptionEventUser,
  wholeDaysBetween,
} from './billingEventDetails';

const PLANS: Record<string, { name: string; interval?: string; tier?: number }> = {
  price_basic: { name: 'Professional', interval: 'monthly', tier: 1 },
  price_basic_yearly: { name: 'Professional', interval: 'yearly', tier: 1 },
  price_pro: { name: 'Team', interval: 'monthly', tier: 2 },
  price_side: { name: 'LibreOncology', interval: 'monthly' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPlan.mockImplementation((priceId: string) => PLANS[priceId]);
});

describe('planDetails', () => {
  it('names a plan by its name and interval', () => {
    expect(planDetails('price_basic')).toEqual({ plan: 'Professional', interval: 'monthly' });
  });

  it('never leaks a price id it does not recognise', () => {
    // A retired or Dashboard-made price means nothing outside Stripe, so it reads as unknown.
    expect(planDetails('price_1Nretired')).toEqual({ plan: 'unknown' });
    expect(planDetails(null)).toEqual({ plan: 'unknown' });
    expect(mockPlan).toHaveBeenCalledTimes(1);
  });
});

describe('planChangeDirection', () => {
  it('reads the direction off the plan tiers', () => {
    expect(planChangeDirection('price_basic', 'price_pro')).toBe('upgrade');
    expect(planChangeDirection('price_pro', 'price_basic')).toBe('downgrade');
    expect(planChangeDirection('price_basic', 'price_basic_yearly')).toBe('same_tier');
  });

  it('says unknown rather than inventing a direction off the plan ladder', () => {
    expect(planChangeDirection('price_basic', 'price_side')).toBe('unknown');
    expect(planChangeDirection('price_gone', 'price_pro')).toBe('unknown');
  });
});

describe('wholeDaysBetween', () => {
  it('counts whole days, rounding down', () => {
    expect(wholeDaysBetween('2026-01-01T00:00:00Z', '2026-01-31T12:00:00Z')).toBe(30);
    expect(wholeDaysBetween(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T23:59:59Z'))).toBe(0);
  });

  it('has no answer for a missing, unparseable or backwards span', () => {
    expect(wholeDaysBetween(undefined, '2026-01-31')).toBeUndefined();
    expect(wholeDaysBetween('not a date', '2026-01-31')).toBeUndefined();
    expect(wholeDaysBetween('2026-02-01', '2026-01-01')).toBeUndefined();
  });
});

describe('subscriptionEventUser', () => {
  it("looks up a user-owned subscription's owner", async () => {
    mockFindById.mockResolvedValue({ id: 'u1' });
    await expect(subscriptionEventUser({ ownerType: SubscriptionOwnerType.User, ownerId: 'u1' })).resolves.toEqual({
      id: 'u1',
    });
    expect(mockFindById).toHaveBeenCalledWith('u1');
  });

  it("names nobody for an organization's, without a lookup", async () => {
    await expect(
      subscriptionEventUser({ ownerType: SubscriptionOwnerType.Organization, ownerId: 'org_1' })
    ).resolves.toBeNull();
    await expect(subscriptionEventUser(null)).resolves.toBeNull();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('turns a failed lookup into nobody rather than a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFindById.mockRejectedValue(new Error('db down'));
    await expect(subscriptionEventUser({ ownerType: SubscriptionOwnerType.User, ownerId: 'u1' })).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe('creditBuyerForEvents', () => {
  it('finds the buyer by Stripe customer first, then by the metadata user id', async () => {
    mockFindByStripeCustomerId.mockResolvedValueOnce({ id: 'by-customer' });
    await expect(creditBuyerForEvents('cus_1', 'u1')).resolves.toEqual({ id: 'by-customer' });
    expect(mockFindById).not.toHaveBeenCalled();

    mockFindByStripeCustomerId.mockResolvedValueOnce(null);
    mockFindById.mockResolvedValueOnce({ id: 'u1' });
    await expect(creditBuyerForEvents('cus_1', 'u1')).resolves.toEqual({ id: 'u1' });
    await expect(creditBuyerForEvents(undefined, undefined)).resolves.toBeNull();
  });

  it('turns a failed lookup into nobody rather than a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFindByStripeCustomerId.mockRejectedValue(new Error('db down'));
    await expect(creditBuyerForEvents('cus_1', 'u1')).resolves.toBeNull();
    warn.mockRestore();
  });
});
