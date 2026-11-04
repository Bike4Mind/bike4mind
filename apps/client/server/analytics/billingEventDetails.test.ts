// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockFindById,
  mockFindByStripeCustomerId,
  mockPlan,
  mockFindVisitId,
  mockRecordCheckoutStart,
  mockListSessions,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindByStripeCustomerId: vi.fn(),
  mockPlan: vi.fn(),
  mockFindVisitId: vi.fn(),
  mockRecordCheckoutStart: vi.fn(),
  mockListSessions: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mockFindById, findByStripeCustomerId: mockFindByStripeCustomerId },
  paymentAttemptRepository: { findVisitId: mockFindVisitId, recordCheckoutStart: mockRecordCheckoutStart },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: { checkout: { sessions: { list: mockListSessions } } },
}));
vi.mock('@client/lib/userSubscriptions/utils', () => ({ getEntitlingPlanByPriceId: mockPlan }));

import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  creditBuyerForEvents,
  planChangeDirection,
  planDetails,
  purchaseVisitId,
  recordCheckoutVisit,
  subscriptionCheckoutVisitId,
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

describe('the visit a purchase was made in', () => {
  const visitId = 'a'.repeat(32);
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("reads a credit pack's visit from its payment intent's attempt, and none when there is none", async () => {
    mockFindVisitId.mockResolvedValueOnce(visitId).mockResolvedValueOnce(null);
    await expect(purchaseVisitId('pi_1')).resolves.toBe(visitId);
    await expect(purchaseVisitId('pi_2')).resolves.toBeUndefined();
    expect(mockFindVisitId.mock.calls).toEqual([['pi_1'], ['pi_2']]);

    mockFindVisitId.mockRejectedValueOnce(new Error('db down'));
    await expect(purchaseVisitId('pi_3')).resolves.toBeUndefined();
  });

  it("finds a subscription's Checkout session from the subscription, then reads that session's visit", async () => {
    mockListSessions.mockResolvedValue({ data: [{ id: 'cs_1' }] });
    mockFindVisitId.mockResolvedValue(visitId);

    await expect(subscriptionCheckoutVisitId('sub_1')).resolves.toBe(visitId);
    expect(mockListSessions).toHaveBeenCalledExactlyOnceWith({ subscription: 'sub_1', limit: 1 });
    expect(mockFindVisitId).toHaveBeenCalledExactlyOnceWith('cs_1');
  });

  it('names no visit for a subscription no Checkout opened, or when Stripe cannot be read', async () => {
    mockListSessions.mockResolvedValueOnce({ data: [] });
    await expect(subscriptionCheckoutVisitId('sub_1')).resolves.toBeUndefined();
    expect(mockFindVisitId).not.toHaveBeenCalled();

    mockListSessions.mockRejectedValueOnce(new Error('stripe down'));
    await expect(subscriptionCheckoutVisitId('sub_1')).resolves.toBeUndefined();
  });

  it('keeps a Checkout visit under its session, writes nothing without a visit, and never throws', async () => {
    await recordCheckoutVisit({ checkoutSessionId: 'cs_1', userId: 'u1', visitId });
    expect(mockRecordCheckoutStart).toHaveBeenCalledExactlyOnceWith({
      checkoutSessionId: 'cs_1',
      userId: 'u1',
      visitId,
    });

    mockRecordCheckoutStart.mockClear();
    await recordCheckoutVisit({ checkoutSessionId: 'cs_2', userId: 'u1', visitId: undefined });
    expect(mockRecordCheckoutStart).not.toHaveBeenCalled();

    mockRecordCheckoutStart.mockRejectedValueOnce(new Error('db down'));
    await expect(recordCheckoutVisit({ checkoutSessionId: 'cs_3', userId: 'u1', visitId })).resolves.toBeUndefined();
  });
});
