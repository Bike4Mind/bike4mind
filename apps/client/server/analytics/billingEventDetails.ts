import { userRepository } from '@bike4mind/database';
import { SubscriptionOwnerType, type ISubscription } from '@bike4mind/server-utils/lib/subscriptions/types';
import { getEntitlingPlanByPriceId } from '@client/lib/userSubscriptions/utils';

// What the billing events in signupEvents.ts carry and who they are about, kept apart from it so
// the emitter does not import the plan catalogue or the database. Overwatch's
// docs/events-integration.md lists these metadata keys, so a change here is a change to that
// contract.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The user a subscription's billing events are about: its owner when a user owns it, and nobody
 * for an organization's, whose events no one user's signup can attribute - the same rule
 * purchases follow. Never throws: a failed lookup sends nothing rather than failing a webhook.
 */
export async function subscriptionEventUser(row: Pick<ISubscription, 'ownerType' | 'ownerId'> | null | undefined) {
  if (!row || row.ownerType !== SubscriptionOwnerType.User || !row.ownerId) return null;
  try {
    return await userRepository.findById(row.ownerId);
  } catch {
    console.warn('[b4m-analytics] billing event user lookup failed');
    return null;
  }
}

/**
 * A plan as an analytics event should name it: the plan's name and billing interval, never the
 * Stripe price id, which means nothing outside Stripe and changes whenever a price is recreated.
 * A price this deployment does not know (a retired plan, one created in the Stripe Dashboard)
 * reads as `unknown` rather than leaking the id.
 */
export function planDetails(priceId: string | null | undefined): { plan: string; interval?: string } {
  const plan = priceId ? getEntitlingPlanByPriceId(priceId) : undefined;
  if (!plan) return { plan: 'unknown' };
  return { plan: plan.name, ...(plan.interval && { interval: plan.interval }) };
}

export type PlanChangeDirection = 'upgrade' | 'downgrade' | 'same_tier' | 'unknown';

/**
 * Which way a move between two prices goes, by plan tier. `unknown` when either price has no
 * tier: an unrecognised price, or a plan that is not a rung on the plan ladder (LibreOncology is
 * a separate product), where "up" or "down" would be invented.
 */
export function planChangeDirection(fromPriceId: string, toPriceId: string): PlanChangeDirection {
  const from = getEntitlingPlanByPriceId(fromPriceId)?.tier;
  const to = getEntitlingPlanByPriceId(toPriceId)?.tier;
  if (from === undefined || to === undefined) return 'unknown';
  if (to > from) return 'upgrade';
  if (to < from) return 'downgrade';
  return 'same_tier';
}

/** Whole days from `from` to `to`, or undefined when either is missing or unparseable. */
export function wholeDaysBetween(
  from: Date | string | null | undefined,
  to: Date | string | null | undefined
): number | undefined {
  if (!from || !to) return undefined;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / DAY_MS) : undefined;
}

/**
 * The Mongoose timestamps every Subscription row carries (the schema sets `timestamps: true`)
 * and ISubscription does not declare.
 */
export function rowTimestamps(row: ISubscription): { createdAt?: Date; updatedAt?: Date } {
  const { createdAt, updatedAt } = row as ISubscription & { createdAt?: Date; updatedAt?: Date };
  return { createdAt, updatedAt };
}

/**
 * The buyer of a credit pack, found the way payment_intent.succeeded finds them: the Stripe
 * customer first, then the server-set metadata user id. Never throws.
 */
export async function creditBuyerForEvents(customerId: string | undefined, metadataUserId: string | undefined) {
  try {
    const byCustomer = customerId ? await userRepository.findByStripeCustomerId(customerId) : null;
    return byCustomer ?? (metadataUserId ? await userRepository.findById(metadataUserId) : null);
  } catch {
    console.warn('[b4m-analytics] billing event user lookup failed');
    return null;
  }
}
