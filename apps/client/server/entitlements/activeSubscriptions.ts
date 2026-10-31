import type { IMongoDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import type { ActivePlanResolver } from '@bike4mind/services';
import { SubscriptionOwnerType, type ISubscription } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import type { MembershipRequest } from '@bike4mind/server-utils/dataLakes/requestMembership';

export type ActiveSubscription = ISubscription & IMongoDocument;

async function getActiveOrgSubscriptionsForUser(userId: string): Promise<ActiveSubscription[]> {
  const orgIds = await organizationRepository.findPlanHolderOrgIds(userId);
  if (orgIds.length === 0) return [];
  return subscriptionRepository.findActiveSubscriptionsByOwners(SubscriptionOwnerType.Organization, orgIds);
}

/**
 * Every ACTIVE subscription that grants this user a plan: their own rows plus the rows of every
 * org that holds a plan for them (owner, users[] member - membership is the seat - or the org's
 * manager / an appointed admin, who get the plan without a member row). The single source for
 * entitlements, rate tier and the `/api/v1/me` plan, so the three cannot disagree.
 *
 * Deliberately uncached across requests so removing a member or lapsing an org plan takes effect
 * on the next request.
 *
 * If the org leg (membership or org-subscription read) fails, this degrades to the user's own rows
 * and logs: a seat member is under-granted for that request (the pre-seat behavior) instead of
 * every gated route and `/me` failing for every org member. The user-row read still throws.
 * Access gates opt into strict so an unknown plan yields a retryable error, not denial.
 */
export async function getActiveSubscriptionsForUser(
  userId: string,
  options?: { strict?: boolean }
): Promise<ActiveSubscription[]> {
  const resolveOrgRows = async (): Promise<ActiveSubscription[]> => {
    try {
      return await getActiveOrgSubscriptionsForUser(userId);
    } catch (error) {
      if (options?.strict) throw error;
      Logger.globalInstance.warn('[entitlements] org-seat resolution failed; using user-owned subscriptions only', {
        userId,
        error,
      });
      return [];
    }
  };
  const [userRows, orgRows] = await Promise.all([
    subscriptionRepository.findActiveUserSubscriptions(userId),
    resolveOrgRows(),
  ]);
  return orgRows.length === 0 ? userRows : [...userRows, ...orgRows];
}

/**
 * The billing check must distinguish no plan from an unreadable plan: the entitlement fallback
 * above under-grants access, but reusing it here would charge a paid seat as a free-tier holder.
 */
export const activePlanResolver: ActivePlanResolver = {
  hasActivePlan: async userId => {
    const ownSubscriptions = await subscriptionRepository.findActiveUserSubscriptions(userId);
    if (ownSubscriptions.length > 0) return true;
    return (await getActiveOrgSubscriptionsForUser(userId)).length > 0;
  },
};

export interface ActiveSubscriptionsRequest extends MembershipRequest {
  activeSubscriptions?: ActiveSubscription[];
  /** A degraded org read must never be reused by an access gate. */
  activeSubscriptionsStrict?: boolean;
}

/**
 * Per-request memo of `getActiveSubscriptionsForUser` for the authenticated caller, so the rate
 * limiter, the entitlement gate and `/me` share one set of reads within a request. A rejection is
 * not memoized. Plan-holder orgs are resolved separately and never written to `req.membershipOrgIds`:
 * managers/admins get the plan, not data access.
 */
export async function getRequestActiveSubscriptions(
  req: ActiveSubscriptionsRequest,
  options?: { strict?: boolean }
): Promise<ActiveSubscription[]> {
  if (!req.user) return [];
  const user = req.user;
  if (req.activeSubscriptions && (!options?.strict || req.activeSubscriptionsStrict)) {
    return req.activeSubscriptions;
  }
  const subscriptions = await getActiveSubscriptionsForUser(user.id, options);
  req.activeSubscriptions = subscriptions;
  req.activeSubscriptionsStrict = options?.strict === true;
  return subscriptions;
}
