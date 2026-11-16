import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../premium-generated/premiumEntitlementGrants.generated', () => ({ premiumEntitlementGrants: {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('PaintBox subscription entitlements', () => {
  it.each(['staging', 'production'])('uses only the configured %s Professional and Team prices', async stage => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SEED_STAGE_NAME', stage);
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST', 'price_pro_test');
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD', 'price_pro_prod');
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST', 'price_team_test');
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_PROD', 'price_team_prod');
    const { entitlementsForPriceIds, KNOWN_ENTITLEMENT_KEYS, resolveEntitlements } = await import('./registry');
    const { PROFESSIONAL_PRICE_ID, TEAM_PLAN } = await import('../userSubscriptions/constants');
    const suffix = stage === 'production' ? 'prod' : 'test';
    expect(PROFESSIONAL_PRICE_ID).toBe(`price_pro_${suffix}`);
    expect(TEAM_PLAN.priceId).toBe(`price_team_${suffix}`);
    for (const priceId of [PROFESSIONAL_PRICE_ID, TEAM_PLAN.priceId]) {
      expect(entitlementsForPriceIds([priceId])).toEqual(new Set(['paintbox:pro']));
      expect(resolveEntitlements({ tags: [], activePriceIds: [priceId] })).toContain('paintbox:pro');
    }
    const otherSuffix = suffix === 'prod' ? 'test' : 'prod';
    expect(entitlementsForPriceIds([`price_pro_${otherSuffix}`, `price_team_${otherSuffix}`])).toEqual(new Set());
    expect(resolveEntitlements({ tags: [], activePriceIds: [] })).not.toContain('paintbox:pro');
    expect(entitlementsForPriceIds(['price_unknown'])).not.toContain('paintbox:pro');
    expect(KNOWN_ENTITLEMENT_KEYS).toContain('paintbox:pro');
  });

  it('does not grant PaintBox from an unconfigured or unrelated price', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST', '');
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD', '');
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST', '');
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_PROD', '');
    const { entitlementsForPriceIds, LIBREONCOLOGY_PRO_PRICE_ID } = await import('./registry');
    expect(entitlementsForPriceIds([''])).toEqual(new Set());
    expect(entitlementsForPriceIds([LIBREONCOLOGY_PRO_PRICE_ID])).not.toContain('paintbox:pro');
  });
});
