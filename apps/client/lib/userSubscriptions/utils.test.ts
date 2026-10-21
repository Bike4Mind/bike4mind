// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { UserSubscriptionTier } from './types';

// Price ids are read from env at module load, so stub before importing.
vi.stubEnv('NEXT_PUBLIC_SEED_STAGE_NAME', 'test');
vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST', 'price_team_test');
const { getEntitlingPlanByPriceId } = await import('./utils');

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('getEntitlingPlanByPriceId', () => {
  it('maps the org (Team) plan price to the Pro tier', () => {
    expect(getEntitlingPlanByPriceId('price_team_test')).toMatchObject({
      name: 'Team',
      tier: UserSubscriptionTier.Pro,
    });
  });

  it('confers nothing for an empty or unknown price id', () => {
    expect(getEntitlingPlanByPriceId('')).toBeUndefined();
    expect(getEntitlingPlanByPriceId('price_unknown')).toBeUndefined();
  });
});
