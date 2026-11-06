import { describe, expect, it, vi } from 'vitest';

// Plan price ids come from per-stage env vars, so the plan map is a fixture.
vi.mock('@bike4mind/server-utils/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS: [],
  SUBSCRIPTION_PLANS_MAP: {
    price_basic: { tier: 1 },
    price_standalone: {},
  },
  TEAM_PLAN: { priceId: 'price_team', tier: 2 },
}));

import {
  entitlementsForPaidSubscription,
  hasPaidSubscription,
  hasPurchasedCredits,
  holdsPaidStanding,
  priceAffectsEntitlements,
  resolvePaidStanding,
} from './paidStanding';

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

describe('entitlementsForPaidSubscription', () => {
  it('grants Questmaster for any active paid plan, ladder or standalone', () => {
    expect(entitlementsForPaidSubscription([{ priceId: 'price_basic' }])).toEqual(['questmaster:pro']);
    expect(entitlementsForPaidSubscription([{ priceId: 'price_standalone' }])).toEqual(['questmaster:pro']);
  });

  it('grants nothing without an active paid subscription', () => {
    expect(entitlementsForPaidSubscription([])).toEqual([]);
    expect(entitlementsForPaidSubscription([{ priceId: 'price_unknown' }])).toEqual([]);
  });
});

describe('priceAffectsEntitlements', () => {
  it('is true for a paid plan price that has no registry price row', () => {
    expect(priceAffectsEntitlements('price_basic')).toBe(true);
    expect(priceAffectsEntitlements('price_team')).toBe(true);
  });

  it('is false for an unknown or empty price', () => {
    expect(priceAffectsEntitlements('price_unknown')).toBe(false);
    expect(priceAffectsEntitlements('')).toBe(false);
  });
});

describe('resolvePaidStanding', () => {
  it('returns standing and subscriber keys together for an active paid plan', () => {
    expect(resolvePaidStanding({}, [{ priceId: 'price_basic' }])).toEqual({
      holdsPaidStanding: true,
      subscriberKeys: ['questmaster:pro'],
    });
  });

  it('gives standing without subscriber keys to a credit buyer with no plan', () => {
    expect(resolvePaidStanding({ lastCreditsPurchasedAt: PURCHASED }, [])).toEqual({
      holdsPaidStanding: true,
      subscriberKeys: [],
    });
  });

  it('gives neither without a purchase or a paid row', () => {
    expect(resolvePaidStanding({}, [{ priceId: 'price_unknown' }])).toEqual({
      holdsPaidStanding: false,
      subscriberKeys: [],
    });
  });
});
