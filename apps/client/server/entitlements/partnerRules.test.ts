import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindActiveRules = vi.fn();
vi.mock('@bike4mind/database', () => ({
  partnerSignupRuleRepository: {
    findActiveRules: (...a: any[]) => mockFindActiveRules(...a),
  },
}));

import { partnerEntitlementsForEmail, partnerSignupGrantForEmail, invalidatePartnerRuleCache } from './partnerRules';

const RULE = {
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

  it('signup grant reports matched=false for a non-matching domain (env fallback signal)', async () => {
    const grant = await partnerSignupGrantForEmail('a@other.com', true);
    expect(grant.matched).toBe(false);
    expect(grant.signupCredits).toBe(0);
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
