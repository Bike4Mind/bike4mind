import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindActiveRules = vi.fn();
vi.mock('@bike4mind/database', () => ({
  partnerSignupRuleRepository: {
    findActiveRules: (...a: any[]) => mockFindActiveRules(...a),
  },
}));

import {
  assertKnownSubscriptionPlan,
  partnerEntitlementsForEmail,
  partnerSignupGrantForEmail,
  invalidatePartnerRuleCache,
} from './partnerRules';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';

const RULE = {
  id: 'rule-1',
  domain: 'partner.com',
  entitlements: ['optihashi:pro'],
  signupCredits: 150_000,
};

describe('partnerRules resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidatePartnerRuleCache();
    mockFindActiveRules.mockResolvedValue([RULE]);
  });

  it('resolves entitlement keys for a verified matching domain', async () => {
    const keys = await partnerEntitlementsForEmail('someone@partner.com', true);
    expect([...keys]).toEqual(['optihashi:pro']);
  });

  it('grants nothing when the email is unverified', async () => {
    const keys = await partnerEntitlementsForEmail('someone@partner.com', false);
    expect(keys.size).toBe(0);
  });

  it('grants nothing for a domain with no rule', async () => {
    const keys = await partnerEntitlementsForEmail('someone@other.com', true);
    expect(keys.size).toBe(0);
  });

  it('matches the domain case-insensitively (substring after the last @)', async () => {
    const keys = await partnerEntitlementsForEmail('Someone@PARTNER.com', true);
    expect([...keys]).toEqual(['optihashi:pro']);
  });

  it('signup grant reports matched=true with the per-rule credit amount', async () => {
    const grant = await partnerSignupGrantForEmail('a@partner.com', true);
    expect(grant.matched).toBe(true);
    expect(grant.signupCredits).toBe(150_000);
    expect([...grant.entitlements]).toEqual(['optihashi:pro']);
  });

  it('signup grant identifies the matched rule by id and normalized domain', async () => {
    mockFindActiveRules.mockResolvedValue([{ ...RULE, domain: 'Partner.COM' }]);
    const grant = await partnerSignupGrantForEmail('a@partner.com', true);
    expect(grant).toMatchObject({ matched: true, ruleId: 'rule-1', domain: 'partner.com' });
  });

  it('signup grant reports matched=false for a non-matching domain (env fallback signal)', async () => {
    const grant = await partnerSignupGrantForEmail('a@other.com', true);
    expect(grant.matched).toBe(false);
    expect(grant.signupCredits).toBe(0);
    expect(grant.organizationId).toBeNull();
  });

  it('signup grant carries the rule organizationId when set, and null when absent', async () => {
    mockFindActiveRules.mockResolvedValue([{ ...RULE, organizationId: 'org-123' }]);
    expect((await partnerSignupGrantForEmail('a@partner.com', true)).organizationId).toBe('org-123');

    invalidatePartnerRuleCache();
    mockFindActiveRules.mockResolvedValue([RULE]); // no organizationId on the rule
    expect((await partnerSignupGrantForEmail('a@partner.com', true)).organizationId).toBeNull();
  });

  it('signup grant carries the matched rule tags, and none when the rule has no tags', async () => {
    mockFindActiveRules.mockResolvedValue([{ ...RULE, tags: ['Partner', 'cohort-a'] }]);
    expect((await partnerSignupGrantForEmail('a@partner.com', true)).tags).toEqual(['Partner', 'cohort-a']);

    invalidatePartnerRuleCache();
    mockFindActiveRules.mockResolvedValue([RULE]);
    expect((await partnerSignupGrantForEmail('a@partner.com', true)).tags).toEqual([]);
  });

  it('signup grant carries no tags for a non-matching domain', async () => {
    mockFindActiveRules.mockResolvedValue([{ ...RULE, tags: ['Partner'] }]);
    expect((await partnerSignupGrantForEmail('a@other.com', true)).tags).toEqual([]);
  });

  it('signup grant carries no tags once the rule is disabled (absent from the active set)', async () => {
    // findActiveRules filters `enabled: true` (covered in PartnerSignupRuleModel.test.ts), so a
    // disabled rule never reaches the resolver.
    mockFindActiveRules.mockResolvedValue([]);
    const grant = await partnerSignupGrantForEmail('a@partner.com', true);
    expect(grant.matched).toBe(false);
    expect(grant.tags).toEqual([]);
  });

  it('signup grant carries the rule id, domain and subscription, and null when the rule has none', async () => {
    const subscription = { priceId: 'price_pro', durationMonths: 3 };
    mockFindActiveRules.mockResolvedValue([{ ...RULE, subscription }]);
    expect(await partnerSignupGrantForEmail('a@partner.com', true)).toMatchObject({
      ruleId: 'rule-1',
      domain: 'partner.com',
      subscription,
    });

    invalidatePartnerRuleCache();
    mockFindActiveRules.mockResolvedValue([RULE]);
    expect((await partnerSignupGrantForEmail('a@partner.com', true)).subscription).toBeNull();
  });

  it('assertKnownSubscriptionPlan accepts a catalog plan and no subscription, and rejects an unknown price', () => {
    expect(() => assertKnownSubscriptionPlan(null)).not.toThrow();
    expect(() => assertKnownSubscriptionPlan(undefined)).not.toThrow();
    expect(() => assertKnownSubscriptionPlan({ priceId: SUBSCRIPTION_PLANS[0].priceId })).not.toThrow();
    expect(() => assertKnownSubscriptionPlan({ priceId: 'price_nope' })).toThrow(/Unknown subscription plan/);
  });

  it('caches the rule set so repeated resolutions hit the DB once', async () => {
    await partnerEntitlementsForEmail('a@partner.com', true);
    await partnerEntitlementsForEmail('b@partner.com', true);
    await partnerSignupGrantForEmail('c@partner.com', true);
    expect(mockFindActiveRules).toHaveBeenCalledTimes(1);
  });

  it('reloads from the DB after the cache is invalidated', async () => {
    await partnerEntitlementsForEmail('a@partner.com', true);
    expect(mockFindActiveRules).toHaveBeenCalledTimes(1);

    invalidatePartnerRuleCache();
    await partnerEntitlementsForEmail('a@partner.com', true);
    expect(mockFindActiveRules).toHaveBeenCalledTimes(2);
  });
});
