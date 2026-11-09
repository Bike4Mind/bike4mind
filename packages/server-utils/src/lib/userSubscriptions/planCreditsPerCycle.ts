import { getTeamPlanSettings } from '../../services/teamPlanSettings';
import { SubscriptionOwnerType } from '../subscriptions/types';
import { findSubscriptionPlan } from './constants';

/**
 * The credits a plan carries each cycle, before any per-subscription override or grant-time skip
 * (the re-subscribe cooldown in apps/workers/src/lib/userSubscriptions/serverUtils.ts). Must stay in sync with
 * that grant: an individual plan's allotment, or the Team plan's per-seat allotment times seats.
 */
export async function planCreditsPerCycle(params: {
  ownerType: SubscriptionOwnerType | `${SubscriptionOwnerType}`;
  priceId: string | null | undefined;
  quantity: number;
}): Promise<number | null> {
  if (params.ownerType === SubscriptionOwnerType.User) {
    return (params.priceId && findSubscriptionPlan(params.priceId)?.credits) || null;
  }
  return params.quantity * (await getTeamPlanSettings()).creditsPerSeat;
}
