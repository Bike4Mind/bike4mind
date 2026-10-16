import type { IMongoDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { SubscriptionOwnerType, type ISubscription } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';

export interface ActiveSubscriptionsOptions {
  /** The caller's org-membership ids when already resolved (e.g. `req.membershipOrgIds`), skipping that read. */
  membershipOrgIds?: readonly string[];
}

/**
 * Every ACTIVE subscription that grants this user a plan: their own rows plus the rows of every
 * org they belong to (owner or users[] member - membership is the seat). The single source for
 * entitlements, rate tier and the `/api/v1/me` plan, so the three cannot disagree.
 *
 * Deliberately uncached across requests so removing a member or lapsing an org plan takes effect
 * on the next request.
 */
export async function getActiveSubscriptionsForUser(
  userId: string,
  opts: ActiveSubscriptionsOptions = {}
): Promise<(ISubscription & IMongoDocument)[]> {
  const [userRows, orgIds] = await Promise.all([
    subscriptionRepository.findActiveUserSubscriptions(userId),
    opts.membershipOrgIds ?? organizationRepository.findMembershipOrgIds(userId),
  ]);
  if (orgIds.length === 0) return userRows;
  const orgRows = await subscriptionRepository.findActiveSubscriptionsByOwners(
    SubscriptionOwnerType.Organization,
    orgIds
  );
  return [...userRows, ...orgRows];
}
