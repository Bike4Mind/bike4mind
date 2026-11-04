import { describe, expect, it, vi } from 'vitest';

// Plan price ids come from per-stage env vars, so the plan map is a fixture.
vi.mock('@client/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS: [],
  SUBSCRIPTION_PLANS_MAP: {
    price_basic: { tier: 1 },
    price_standalone: {},
  },
  TEAM_PLAN: { priceId: 'price_team', tier: 2 },
}));

import { hasPaidSubscription, hasPurchasedCredits, holdsPaidStanding } from './paidStanding';

const PURCHASED = new Date('2026-10-01T00:00:00Z');

describe('hasPurchasedCredits', () => {
  it('is true only for a stamped purchase', () => {
    expect(hasPurchasedCredits({ lastCreditsPurchasedAt: PURCHASED })).toBe(true);
    expect(hasPurchasedCredits({ lastCreditsPurchasedAt: null })).toBe(false);
    expect(hasPurchasedCredits({})).toBe(false);
  });
});

describe('hasPaidSubscription', () => {
  it('counts ladder, Team and standalone plans as paid', () => {
    expect(hasPaidSubscription([{ priceId: 'price_basic' }])).toBe(true);
    expect(hasPaidSubscription([{ priceId: 'price_team' }])).toBe(true);
    expect(hasPaidSubscription([{ priceId: 'price_standalone' }])).toBe(true);
  });

  it('treats no rows, unknown and empty price ids as not paid', () => {
    expect(hasPaidSubscription([])).toBe(false);
    expect(hasPaidSubscription([{ priceId: 'price_unknown' }, { priceId: '' }])).toBe(false);
  });
});

describe('holdsPaidStanding', () => {
  it('holds for a credit buyer with no plan', () => {
    expect(holdsPaidStanding({ lastCreditsPurchasedAt: PURCHASED }, [])).toBe(true);
  });

  it('holds for an account with a paid plan and no purchase', () => {
    expect(holdsPaidStanding({ lastCreditsPurchasedAt: null }, [{ priceId: 'price_standalone' }])).toBe(true);
  });

  // Org seats arrive as rows from getActiveSubscriptionsForUser; an account that holds no seat has none.
  it('does not hold without a purchase or a paid row', () => {
    expect(holdsPaidStanding({}, [])).toBe(false);
    expect(holdsPaidStanding({ lastCreditsPurchasedAt: null }, [{ priceId: 'price_unknown' }])).toBe(false);
  });
});
