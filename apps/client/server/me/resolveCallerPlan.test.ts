// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { SubscriptionPlanInterval, UserSubscriptionTier } from '@client/lib/userSubscriptions/types';

const { mockPlanByPriceId } = vi.hoisted(() => ({ mockPlanByPriceId: vi.fn() }));

vi.mock('@client/lib/userSubscriptions/utils', () => ({ getEntitlingPlanByPriceId: mockPlanByPriceId }));

const { resolveCallerPlan } = await import('./resolveCallerPlan');

const PERIOD_END = new Date('2026-10-18T00:00:00.000Z');

const professional = {
  priceId: 'price_pro',
  name: 'Professional',
  interval: SubscriptionPlanInterval.Monthly,
  credits: 50000,
  tier: UserSubscriptionTier.Basic,
  features: [],
  description: '',
};

const offLadder = {
  priceId: 'price_standalone',
  name: 'LibreOncology',
  interval: SubscriptionPlanInterval.Monthly,
  credits: 31667,
  features: [],
  description: '',
};

const team = {
  priceId: 'price_team',
  name: 'Team',
  interval: SubscriptionPlanInterval.Monthly,
  tier: UserSubscriptionTier.Pro,
};

const sub = (priceId: string, ownerType = SubscriptionOwnerType.User, customCreditsPerCycle?: number) => ({
  priceId,
  periodEndsAt: PERIOD_END,
  ownerType,
  customCreditsPerCycle,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPlanByPriceId.mockImplementation((priceId: string) =>
    [professional, offLadder, team].find(plan => plan.priceId === priceId)
  );
});

describe('resolveCallerPlan', () => {
  it('reports free with no subscription when nothing is active', () => {
    expect(resolveCallerPlan([])).toEqual({
      tier: 'free',
      subscription: null,
      personalMonthlyCreditAllowance: null,
    });
  });

  it('projects an active ladder plan onto its rung', () => {
    expect(resolveCallerPlan([sub('price_pro')])).toEqual({
      tier: 'basic',
      personalMonthlyCreditAllowance: 50000,
      subscription: {
        plan_name: 'Professional',
        price_id: 'price_pro',
        interval: 'monthly',
        current_period_ends_at: '2026-10-18T00:00:00.000Z',
      },
    });
  });

  it('reports an off-ladder paid plan as other rather than free', () => {
    const result = resolveCallerPlan([sub('price_standalone')]);
    expect(result.tier).toBe('other');
    expect(result.subscription?.plan_name).toBe('LibreOncology');
  });

  it('picks the highest ladder rung when several are active', () => {
    const result = resolveCallerPlan([sub('price_standalone'), sub('price_pro')]);
    expect(result.tier).toBe('basic');
    expect(result.subscription?.price_id).toBe('price_pro');
  });

  it('ranks an org seat Team plan above an individual Professional plan', () => {
    const result = resolveCallerPlan([sub('price_pro'), sub('price_team', SubscriptionOwnerType.Organization)]);
    expect(result.tier).toBe('pro');
    expect(result.subscription?.plan_name).toBe('Team');
    expect(result.personalMonthlyCreditAllowance).toBe(50000);
  });

  it('reports no personal allowance for a Team-only account', () => {
    expect(
      resolveCallerPlan([sub('price_team', SubscriptionOwnerType.Organization)]).personalMonthlyCreditAllowance
    ).toBeNull();
  });

  it('uses the personal subscription override as the actual monthly allowance', () => {
    expect(
      resolveCallerPlan([sub('price_pro', SubscriptionOwnerType.User, 75000)]).personalMonthlyCreditAllowance
    ).toBe(75000);
  });

  it('reports an unnameable plan as other, so a grandfathered subscriber is never called free', () => {
    // The entitlement registry keeps superseded price ids mapped; those have no
    // SUBSCRIPTION_PLANS row, so they cannot be named - but their holder is paying.
    expect(resolveCallerPlan([sub('price_superseded')])).toEqual({
      tier: 'other',
      subscription: null,
      personalMonthlyCreditAllowance: null,
    });
  });
});
