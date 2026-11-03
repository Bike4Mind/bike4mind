// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTeamPlanSettings } from '@bike4mind/common';
import { CREDIT_PACKAGES } from './credits/constants';
import { TransactionType } from './credits/types';

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));

// The catalog reads env-derived price ids at import time, so each test re-imports it under stubbed env
// vars: an unset env would make every id '' and let a wrong source pass by accident.
const loadModules = async () => {
  vi.resetModules();
  const [catalog, plans, orgPlan, credits] = await Promise.all([
    import('./checkoutCatalog'),
    import('./userSubscriptions/constants'),
    import('@bike4mind/server-utils/lib/subscriptions/constants'),
    import('./credits/utils'),
  ]);
  return { catalog, plans, orgPlan, credits };
};

const team = resolveTeamPlanSettings({});

describe('checkout catalog', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SEED_STAGE_NAME', 'dev');
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST', 'price_pro_test');
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD', 'price_pro_prod');
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST', 'price_org_test');
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_PROD', 'price_org_prod');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists every credit pack at the amount and credits package checkout charges and grants', async () => {
    const { catalog, credits } = await loadModules();
    const packs = catalog.listCatalogPacks();

    expect(packs.map(pack => pack.id).sort()).toEqual(Object.keys(CREDIT_PACKAGES).sort());
    for (const pack of packs) {
      const payment = await credits.handlePackageTransaction({
        transactionType: TransactionType.Package,
        packageId: pack.id,
      });
      expect(payment.amount).toBe(pack.priceUsd * 100);
      expect(payment.metadata.credits).toBe(pack.credits);
    }
  });

  it('lists every individual plan as the plan lookup checkout and the invoice grant resolve it', async () => {
    const { catalog, plans } = await loadModules();
    const listed = catalog.listCatalogPlans(team).filter(plan => plan.grant.kind === 'credits');

    expect(listed.map(plan => plan.name).sort()).toEqual(plans.SUBSCRIPTION_PLANS.map(plan => plan.name).sort());
    for (const row of listed) {
      const sold = plans.findSubscriptionPlan(row.priceId);
      expect(sold?.name).toBe(row.name);
      expect(row.grant).toEqual({ kind: 'credits', credits: sold?.credits });
    }
  });

  it('matches the Professional price id the Billing plan cards resolve on a test stage', async () => {
    const { catalog, plans } = await loadModules();
    const professional = catalog.listCatalogPlans(team).find(plan => plan.name === 'Professional');

    expect(professional?.priceId).toBe('price_pro_test');
    expect(professional?.priceId).toBe(plans.professionalPriceIdForStage(true));
  });

  it('lists the Team plan under the price id the org subscribe route accepts', async () => {
    const { catalog, plans, orgPlan } = await loadModules();
    const teamRow = catalog.listCatalogPlans(team).find(plan => plan.name === 'Team');

    expect(teamRow?.priceId).toBe('price_org_test');
    expect(teamRow?.priceId).toBe(orgPlan.ORGANIZATION_SUBSCRIPTION_PRICE_ID);
    expect(plans.isTeamPlanPriceId(teamRow?.priceId ?? '')).toBe(true);
  });

  it('marks the Team grant unavailable rather than showing defaults when settings could not be read', async () => {
    const { catalog } = await loadModules();
    const teamRow = catalog.listCatalogPlans(undefined).find(plan => plan.name === 'Team');

    expect(teamRow?.grant).toEqual({ kind: 'unavailable' });
  });
});
