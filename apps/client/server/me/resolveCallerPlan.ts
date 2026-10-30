import type { MeSubscription, MeTier } from '@bike4mind/common';
import { SubscriptionOwnerType, type ISubscription } from '@bike4mind/server-utils/lib/subscriptions/types';
import { getEntitlingPlanByPriceId } from '@client/lib/userSubscriptions/utils';
import { SubscriptionPlanInterval, UserSubscriptionTier } from '@client/lib/userSubscriptions/types';
import { resolveSubscriptionCycleCredits } from '@client/lib/userSubscriptions/cycleCredits';

const TIER_KEYS: Record<UserSubscriptionTier, MeTier> = {
  [UserSubscriptionTier.Basic]: 'basic',
  [UserSubscriptionTier.Pro]: 'pro',
};

/** Only the fields the projection reads, so any active-subscription row fits. */
type ActiveSubscription = Pick<ISubscription, 'priceId' | 'periodEndsAt' | 'ownerType' | 'customCreditsPerCycle'>;

type PricedSubscription = {
  subscription: ActiveSubscription;
  plan: NonNullable<ReturnType<typeof getEntitlingPlanByPriceId>>;
};

function bestPlan(priced: readonly PricedSubscription[]): PricedSubscription | undefined {
  return [...priced].sort((a, b) => {
    const tierDiff = (b.plan.tier ?? 0) - (a.plan.tier ?? 0);
    if (tierDiff !== 0) return tierDiff;
    return new Date(b.subscription.periodEndsAt).getTime() - new Date(a.subscription.periodEndsAt).getTime();
  })[0];
}

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
  personalMonthlyCreditAllowance: number | null;
} {
  if (active.length === 0) {
    return { tier: 'free', subscription: null, personalMonthlyCreditAllowance: null };
  }

  const priced = active.flatMap(subscription => {
    const plan = getEntitlingPlanByPriceId(subscription.priceId);
    return plan ? [{ subscription, plan }] : [];
  });

  if (priced.length === 0) {
    return { tier: 'other', subscription: null, personalMonthlyCreditAllowance: null };
  }

  // Highest ladder rung wins when a caller holds several. An off-ladder plan
  // (`tier` omitted) sorts below every rung but is still paid - see MeTier.
  // `getActiveSubscriptionsForUser` returns rows in no guaranteed order, so a tie on
  // rung breaks by the later period end - the subscription that outlasts the rest.
  const best = bestPlan(priced)!;
  const personalMonthlyGrants = active.flatMap(subscription => {
    if (subscription.ownerType !== SubscriptionOwnerType.User) return [];
    const plan = getEntitlingPlanByPriceId(subscription.priceId);
    if (!plan) return [null];
    if (plan.interval !== SubscriptionPlanInterval.Monthly) return [];
    const credits = resolveSubscriptionCycleCredits(plan.credits, subscription.customCreditsPerCycle);
    return [credits];
  });
  const totalMonthlyCredits = personalMonthlyGrants.reduce<number>((total, credits) => total + (credits ?? 0), 0);
  const personalMonthlyCreditAllowance = personalMonthlyGrants.every(credits => credits !== null)
    ? resolveSubscriptionCycleCredits(totalMonthlyCredits)
    : null;

  return {
    tier: best.plan.tier ? TIER_KEYS[best.plan.tier] : 'other',
    personalMonthlyCreditAllowance,
    subscription: {
      plan_name: best.plan.name,
      price_id: best.plan.priceId,
      interval: best.plan.interval === SubscriptionPlanInterval.Yearly ? 'yearly' : 'monthly',
      current_period_ends_at: new Date(best.subscription.periodEndsAt).toISOString(),
    },
  };
}
