import { entitlementsForPriceIds } from '@bike4mind/server-utils/lib/entitlements/registry';
import type { EntitlementKey } from '@bike4mind/server-utils/lib/entitlements/types';
import { getEntitlingPlanByPriceId } from '@client/lib/userSubscriptions/utils';

/**
 * Paid standing: the one answer to "is this account paid" for every free-tier gate - the `plan:paid`
 * entitlement (paid-only models, default model choice), the rate tier floor, the free daily spend caps
 * and API key / CLI access. Admin and developer bypasses are separate exemptions, not paid standing.
 *
 * Sources: an active paid subscription the account holds (its own, an `admin_grant` comp row, or an org
 * plan it holds a seat on - `getActiveSubscriptionsForUser` resolves which orgs count), or an unreversed
 * credit purchase. `addCredits` with type `purchase` stamps `lastCreditsPurchasedAt`; an admin credit
 * grant re-stamps only an account that still has an unreversed purchase row (adminUpdate.ts), so it never confers
 * paid standing on its own. A full refund or lost dispute marks the purchase row reversed and clears the
 * stamp once no unreversed purchase remains (server/billing/purchaseReversal.ts); a partial refund keeps it.
 */
export interface PaidStandingUser {
  lastCreditsPurchasedAt?: Date | null;
}

/** The purchase half of paid standing, for callers that can answer without reading subscriptions. */
export const hasPurchasedCredits = (user: PaidStandingUser): boolean => Boolean(user.lastCreditsPurchasedAt);

/** Whether any active subscription is on a paid plan, ladder or standalone. */
export function hasPaidSubscription(activeSubscriptions: readonly { priceId: string }[]): boolean {
  return activeSubscriptions.some(subscription => getEntitlingPlanByPriceId(subscription.priceId) !== undefined);
}

/**
 * Keys every active paid subscription grants, independent of which plan it is. Driven by subscription
 * status only: a credit purchase (`lastCreditsPurchasedAt`) is sticky and never confers these, so the
 * grant ends the moment the last active paid subscription lapses.
 */
export const SUBSCRIBER_ENTITLEMENT_KEYS: readonly EntitlementKey[] = ['questmaster:pro'];

export function entitlementsForPaidSubscription(
  activeSubscriptions: readonly { priceId: string }[]
): readonly EntitlementKey[] {
  return hasPaidSubscription(activeSubscriptions) ? SUBSCRIBER_ENTITLEMENT_KEYS : [];
}

/**
 * Whether a subscription change on this price can flip any entitlement, so the owner's client cache needs a
 * refresh: a registry price row, or any paid plan (which grants SUBSCRIBER_ENTITLEMENT_KEYS).
 */
export function priceAffectsEntitlements(priceId: string): boolean {
  return entitlementsForPriceIds([priceId]).size > 0 || hasPaidSubscription([{ priceId }]);
}

/** Paid standing and the subscriber keys from one pass over the subscriptions, for callers that need both. */
export function resolvePaidStanding(
  user: PaidStandingUser,
  activeSubscriptions: readonly { priceId: string }[]
): { holdsPaidStanding: boolean; subscriberKeys: readonly EntitlementKey[] } {
  const paidSubscription = hasPaidSubscription(activeSubscriptions);
  return {
    holdsPaidStanding: hasPurchasedCredits(user) || paidSubscription,
    subscriberKeys: paidSubscription ? SUBSCRIBER_ENTITLEMENT_KEYS : [],
  };
}

export function holdsPaidStanding(
  user: PaidStandingUser,
  activeSubscriptions: readonly { priceId: string }[]
): boolean {
  return resolvePaidStanding(user, activeSubscriptions).holdsPaidStanding;
}
