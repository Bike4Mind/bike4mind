import { SUBSCRIPTION_PLANS, SUBSCRIPTION_PLANS_MAP, TEAM_PLAN } from '@client/lib/userSubscriptions/constants';
import {
  SubscriptionPlanDetail,
  SubscriptionPlanInterval,
  UserSubscriptionTier,
} from '@bike4mind/server-utils/lib/userSubscriptions/types';

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
): (Pick<SubscriptionPlanDetail, 'priceId' | 'name' | 'interval' | 'tier'> & { credits?: number }) | undefined {
  if (!priceId) return undefined;
  if (Object.hasOwn(SUBSCRIPTION_PLANS_MAP, priceId)) return SUBSCRIPTION_PLANS_MAP[priceId];
  return priceId === TEAM_PLAN.priceId ? TEAM_PLAN : undefined;
}

/**
 * The highest ladder tier across active subscription rows, or undefined when none is on the ladder.
 * Plans with no `tier` (standalone single-product plans sold off the main ladder) confer none.
 */
export function getHighestLadderTier(
  activeSubscriptions: readonly { priceId: string }[]
): UserSubscriptionTier | undefined {
  let highestTier: UserSubscriptionTier | undefined;
  for (const subscription of activeSubscriptions) {
    const planTier = getEntitlingPlanByPriceId(subscription.priceId)?.tier;
    if (planTier !== undefined && (highestTier === undefined || planTier > highestTier)) {
      highestTier = planTier;
    }
  }
  return highestTier;
}

/**
 * Checks if subscription plans are of the same tier.
 */
export function isSameTier(oldTier: UserSubscriptionTier, newTier: UserSubscriptionTier) {
  return oldTier === newTier;
}
