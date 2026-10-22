import { SUBSCRIPTION_PLANS, SUBSCRIPTION_PLANS_MAP, TEAM_PLAN } from '@client/lib/userSubscriptions/constants';
import { SubscriptionPlanDetail, SubscriptionPlanInterval, UserSubscriptionTier } from './types';

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
 * The plan an active subscription row confers, for tier and plan resolution: an individual plan,
 * or the Team plan for an org-owned row. Not for checkout or plan changes, which must stay on
 * SUBSCRIPTION_PLANS.
 */
export function getEntitlingPlanByPriceId(
  priceId: string
): Pick<SubscriptionPlanDetail, 'priceId' | 'name' | 'interval' | 'tier'> | undefined {
  if (!priceId) return undefined;
  return SUBSCRIPTION_PLANS_MAP[priceId] ?? (priceId === TEAM_PLAN.priceId ? TEAM_PLAN : undefined);
}

/**
 * Checks if subscription plans are of the same tier.
 */
export function isSameTier(oldTier: UserSubscriptionTier, newTier: UserSubscriptionTier) {
  return oldTier === newTier;
}
