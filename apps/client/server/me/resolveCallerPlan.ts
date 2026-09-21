import type { MeSubscription, MeTier } from '@bike4mind/common';
import type { ISubscription } from '@client/lib/subscriptions/types';
import { getSubscriptionPlanByPriceId } from '@client/lib/userSubscriptions/utils';
import { SubscriptionPlanInterval, UserSubscriptionTier } from '@client/lib/userSubscriptions/types';

const TIER_KEYS: Record<UserSubscriptionTier, MeTier> = {
  [UserSubscriptionTier.Basic]: 'basic',
  [UserSubscriptionTier.Pro]: 'pro',
};

/** Only the fields the projection reads, so any active-subscription row fits. */
type ActiveSubscription = Pick<ISubscription, 'priceId' | 'periodEndsAt'>;

/**
 * Project a caller's ACTIVE subscriptions onto the published `GET /api/v1/me` shape.
 *
 * Takes the rows rather than fetching them so the handler can resolve `tier` and
 * `entitlements` from one snapshot read, rather than two reads that could race
 * apart. They still resolve the priceId through different tables
 * (`SUBSCRIPTION_PLANS` here, `PRICE_ENTITLEMENT_ROWS` in the entitlement
 * registry), so `tier: 'basic'` with no paid entitlement key is possible.
 *
 * That table split is why an unrecognized priceId still reports `other` rather
 * than `free`: the registry deliberately keeps SUPERSEDED price ids mapped so
 * grandfathered subscribers retain access, and those ids have no plan row. Naming
 * such a plan is impossible (hence `subscription: null`), but calling its holder
 * free would tell an integrator following the documented `tier != 'free'` gate to
 * refuse service to a paying customer.
 */
export function resolveCallerPlan(active: readonly ActiveSubscription[]): {
  tier: MeTier;
  subscription: MeSubscription | null;
} {
  if (active.length === 0) {
    return { tier: 'free', subscription: null };
  }

  const priced = active.flatMap(subscription => {
    const plan = getSubscriptionPlanByPriceId(subscription.priceId);
    return plan ? [{ subscription, plan }] : [];
  });

  if (priced.length === 0) {
    return { tier: 'other', subscription: null };
  }

  // Highest ladder rung wins when a caller holds several. An off-ladder plan
  // (`tier` omitted) sorts below every rung but is still paid - see MeTier.
  // `findActiveUserSubscriptions` returns rows in no guaranteed order, so a tie on
  // rung breaks by the later period end - the subscription that outlasts the rest.
  const [best] = [...priced].sort((a, b) => {
    const tierDiff = (b.plan.tier ?? 0) - (a.plan.tier ?? 0);
    if (tierDiff !== 0) return tierDiff;
    return new Date(b.subscription.periodEndsAt).getTime() - new Date(a.subscription.periodEndsAt).getTime();
  });

  return {
    tier: best.plan.tier ? TIER_KEYS[best.plan.tier] : 'other',
    subscription: {
      plan_name: best.plan.name,
      price_id: best.plan.priceId,
      interval: best.plan.interval === SubscriptionPlanInterval.Yearly ? 'yearly' : 'monthly',
      current_period_ends_at: new Date(best.subscription.periodEndsAt).toISOString(),
    },
  };
}
