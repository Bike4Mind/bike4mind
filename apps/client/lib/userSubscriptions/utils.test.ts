// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { UserSubscriptionTier } from './types';

// Price ids are read from env at module load, so stub before importing.
vi.stubEnv('NEXT_PUBLIC_SEED_STAGE_NAME', 'test');
vi.stubEnv('NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST', 'price_team_test');
const { getEntitlingPlanByPriceId, getHighestLadderTier } = await import('./utils');

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
    expect(getEntitlingPlanByPriceId('__proto__')).toBeUndefined();
    expect(getEntitlingPlanByPriceId('constructor')).toBeUndefined();
    expect(getEntitlingPlanByPriceId('toString')).toBeUndefined();
  });
});

describe('getHighestLadderTier', () => {
  it('is undefined with no subscriptions', () => {
    expect(getHighestLadderTier([])).toBeUndefined();
  });

  it('is undefined for unknown or empty price ids', () => {
    expect(getHighestLadderTier([{ priceId: 'price_unknown' }, { priceId: '' }])).toBeUndefined();
  });

  it('reads the tier of a ladder plan', () => {
    expect(getHighestLadderTier([{ priceId: 'price_team_test' }])).toBe(UserSubscriptionTier.Pro);
  });

  it('takes the highest tier across rows, ignoring off-ladder ones', () => {
    expect(getHighestLadderTier([{ priceId: 'price_unknown' }, { priceId: 'price_team_test' }])).toBe(
      UserSubscriptionTier.Pro
    );
  });
});
