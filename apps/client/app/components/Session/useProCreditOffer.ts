import { useMemo } from 'react';
import { useGetSubscriptionPlans } from '@client/app/hooks/data/stripe';
import { SUBSCRIPTION_PLANS_GROUPED_BY_INTERVAL } from '@client/lib/userSubscriptions/constants';
import { SubscriptionPlanInterval } from '@client/lib/userSubscriptions/types';

export interface ProCreditOffer {
  name: string;
  credits: number;
  /** Monthly price like "$30", or null until the live Stripe price has loaded. */
  priceLabel: string | null;
}

/** The monthly B4M plan the nudges sell. Credits come from SUBSCRIPTION_PLANS; the price from Stripe. */
export function useProCreditOffer(): ProCreditOffer | null {
  const prices = useGetSubscriptionPlans();
  return useMemo(() => {
    const plan = SUBSCRIPTION_PLANS_GROUPED_BY_INTERVAL[SubscriptionPlanInterval.Monthly]?.[0];
    if (!plan) return null;
    const cents = prices.data?.find(price => price.id === plan.priceId)?.unit_amount;
    const dollars = typeof cents === 'number' ? cents / 100 : null;
    const priceLabel = dollars === null ? null : `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
    return { name: plan.name, credits: plan.credits, priceLabel };
  }, [prices.data]);
}
