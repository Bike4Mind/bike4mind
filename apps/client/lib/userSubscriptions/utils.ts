import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { SubscriptionPlanInterval, UserSubscriptionTier } from './types';

export function getIntervalLabel(interval: SubscriptionPlanInterval) {
  switch (interval) {
    case SubscriptionPlanInterval.Monthly:
      return 'Monthly';
    case SubscriptionPlanInterval.Yearly:
      return 'Yearly';
    default:
      return 'Unknown Interval';
  }
}

/**
 * Whether a tier change is an upgrade (newTier outranks oldTier).
 */
export function isUpgrade(oldTier: UserSubscriptionTier, newTier: UserSubscriptionTier) {
  return newTier > oldTier;
}

/**
 * Look up a subscription plan by its Stripe priceId.
 */
export function getSubscriptionPlanByPriceId(priceId: string) {
  return SUBSCRIPTION_PLANS.find(plan => plan.priceId === priceId);
}

/**
 * Checks if subscription plans are of the same tier.
 */
export function isSameTier(oldTier: UserSubscriptionTier, newTier: UserSubscriptionTier) {
  return oldTier === newTier;
}
