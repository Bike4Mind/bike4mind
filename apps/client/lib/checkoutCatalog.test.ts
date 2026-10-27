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

  it('lists every individual plan with the price id and credits the subscribe route validates and grants', async () => {
    const { catalog, plans } = await loadModules();
    const listed = catalog.listCatalogPlans(team);

    for (const plan of plans.SUBSCRIPTION_PLANS) {
      expect(listed).toContainEqual(
        expect.objectContaining({
          name: plan.name,
          priceId: plan.priceId,
          grant: { kind: 'credits', credits: plan.credits },
        })
      );
    }
  });

  it('shows the Professional price id the Billing plan cards send to checkout', async () => {
    const { catalog, plans } = await loadModules();
    const professional = catalog.listCatalogPlans(team).find(plan => plan.name === 'Professional');

    expect(professional?.priceId).toBe('price_pro_test');
    expect(professional?.priceId).toBe(plans.professionalPriceIdForStage(true));
  });

  it('lists the Team plan with the org checkout price id and the resolved seat grant', async () => {
    const { catalog, orgPlan } = await loadModules();
    const teamRow = catalog.listCatalogPlans(team).find(plan => plan.name === 'Team');

    expect(teamRow?.priceId).toBe('price_org_test');
    expect(teamRow?.priceId).toBe(orgPlan.ORGANIZATION_SUBSCRIPTION_PRICE_ID);
    expect(teamRow?.grant).toEqual({ kind: 'perSeat', ...team });
  });
});
