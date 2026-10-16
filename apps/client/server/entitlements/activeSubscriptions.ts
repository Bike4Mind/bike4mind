import type { IMongoDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { SubscriptionOwnerType, type ISubscription } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { getRequestMembershipOrgIds, type MembershipRequest } from '@server/dataLakes/requestMembership';

export type ActiveSubscription = ISubscription & IMongoDocument;

export interface ActiveSubscriptionsOptions {
  /**
   * Resolves the caller's org-membership ids, e.g. `() => getRequestMembershipOrgIds(req)` so the
   * request memo is reused. Lazy so a failure lands inside the org leg and degrades like the rest.
   */
  membershipOrgIds?: () => Promise<readonly string[]>;
}

/**
 * Every ACTIVE subscription that grants this user a plan: their own rows plus the rows of every
 * org they belong to (owner or users[] member - membership is the seat). The single source for
 * entitlements, rate tier and the `/api/v1/me` plan, so the three cannot disagree.
 *
 * Deliberately uncached across requests so removing a member or lapsing an org plan takes effect
 * on the next request.
 *
 * If the org leg (membership or org-subscription read) fails, this degrades to the user's own rows
 * and logs: a seat member is under-granted for that request (the pre-seat behavior) instead of
 * every gated route and `/me` failing for every org member. The user-row read still throws.
 */
export async function getActiveSubscriptionsForUser(
  userId: string,
  opts: ActiveSubscriptionsOptions = {}
): Promise<ActiveSubscription[]> {
  const resolveOrgRows = async (): Promise<ActiveSubscription[]> => {
    try {
      const orgIds = await (opts.membershipOrgIds?.() ?? organizationRepository.findMembershipOrgIds(userId));
      if (orgIds.length === 0) return [];
      return await subscriptionRepository.findActiveSubscriptionsByOwners(SubscriptionOwnerType.Organization, orgIds);
    } catch (error) {
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

export interface ActiveSubscriptionsRequest extends MembershipRequest {
  activeSubscriptions?: ActiveSubscription[];
}

/**
 * Per-request memo of `getActiveSubscriptionsForUser` for the authenticated caller, so the rate
 * limiter, the entitlement gate and `/me` share one set of reads within a request (same pattern as
 * `getRequestMembershipOrgIds`). A rejection is not memoized.
 */
export async function getRequestActiveSubscriptions(req: ActiveSubscriptionsRequest): Promise<ActiveSubscription[]> {
  if (!req.user) return [];
  const user = req.user;
  return (req.activeSubscriptions ??= await getActiveSubscriptionsForUser(user.id, {
    membershipOrgIds: () => getRequestMembershipOrgIds(req),
  }));
}
