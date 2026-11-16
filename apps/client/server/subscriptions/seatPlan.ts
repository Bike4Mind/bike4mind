import { organizationRepository } from '@bike4mind/database';
import type { ActiveSubscription } from '@bike4mind/server-utils/entitlements/activeSubscriptions';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { getEntitlingPlanByPriceId } from '@bike4mind/server-utils/lib/userSubscriptions/utils';

export interface SeatPlan {
  organizationId: string;
  organizationName: string;
  planName: string;
}

/** The paid plan a user holds through an organization, from their resolved active subscriptions. */
export async function resolveSeatPlan(active: readonly ActiveSubscription[]): Promise<SeatPlan | null> {
  for (const subscription of active) {
    if (subscription.ownerType !== SubscriptionOwnerType.Organization) continue;
    const plan = getEntitlingPlanByPriceId(subscription.priceId);
    if (!plan) continue;
    const organization = await organizationRepository.findById(subscription.ownerId);
    if (organization) {
      return { organizationId: organization.id, organizationName: organization.name, planName: plan.name };
    }
  }
  return null;
}
