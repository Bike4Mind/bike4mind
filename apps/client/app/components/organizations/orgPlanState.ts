import {
  isDelinquentSubscriptionStatus,
  resolveSubscriptionSource,
  SubscriptionSource,
  type ISubscription,
} from '@bike4mind/server-utils/lib/subscriptions/types';

/**
 * What a team's displayed subscription (pickDisplayedSubscription) amounts to. Each state is
 * labelled by `organization.plan_states.<state>` in en.json, so every surface names the plan the
 * same way instead of hardcoding "Team Plan".
 */
export type OrgPlanState = 'none' | 'payment_issue' | 'ending' | 'trialing' | 'granted' | 'active';

type PlanSubscription = Pick<ISubscription, 'status' | 'canceledAt'> &
  Partial<Pick<ISubscription, 'source' | 'subscriptionId' | 'cancelAt' | 'cancelAtPeriodEnd'>>;

export function getOrgPlanState(subscription: PlanSubscription | null | undefined): OrgPlanState {
  if (!subscription) return 'none';
  // Delinquent first: a green plan label while entitlements deny access is a false green.
  if (isDelinquentSubscriptionStatus(subscription.status)) return 'payment_issue';
  if (subscription.canceledAt) return 'none';
  // cancelAt also covers a cancel on a custom date, which leaves cancelAtPeriodEnd false.
  if (subscription.cancelAt || subscription.cancelAtPeriodEnd) return 'ending';
  if (subscription.status === 'trialing') return 'trialing';
  if (resolveSubscriptionSource(subscription) === SubscriptionSource.AdminGrant) return 'granted';
  return 'active';
}

/** The plan still grants team features, so its chip reads as success rather than neutral or danger. */
export const isLiveOrgPlan = (state: OrgPlanState): boolean => state !== 'none' && state !== 'payment_issue';

export const orgPlanChipColor = (state: OrgPlanState): 'danger' | 'warning' | 'success' | 'neutral' =>
  state === 'payment_issue' ? 'danger' : state === 'ending' ? 'warning' : isLiveOrgPlan(state) ? 'success' : 'neutral';
