import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const { pricesRef } = vi.hoisted(() => ({
  pricesRef: { current: undefined as undefined | Array<{ id: string; unit_amount: number }> },
}));
vi.mock('@client/app/hooks/data/stripe', () => ({
  useGetSubscriptionPlans: () => ({ data: pricesRef.current }),
}));

import { SUBSCRIPTION_PLANS_GROUPED_BY_INTERVAL } from '@client/lib/userSubscriptions/constants';
import { SubscriptionPlanInterval } from '@client/lib/userSubscriptions/types';
import { useProCreditOffer } from './useProCreditOffer';

const plan = SUBSCRIPTION_PLANS_GROUPED_BY_INTERVAL[SubscriptionPlanInterval.Monthly][0];

describe('useProCreditOffer', () => {
  it('reads name and credits from the plan table and has no price until Stripe loads', () => {
    pricesRef.current = undefined;
    const { result } = renderHook(() => useProCreditOffer());
    expect(result.current).toEqual({ name: plan.name, credits: plan.credits, priceLabel: null });
  });

  it('formats the live Stripe price', () => {
    pricesRef.current = [{ id: plan.priceId, unit_amount: 3000 }];
    const { result } = renderHook(() => useProCreditOffer());
    expect(result.current?.priceLabel).toBe('$30');
  });
});
