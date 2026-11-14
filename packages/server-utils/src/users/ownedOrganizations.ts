import type { IOrganizationDocument, WithId } from '@bike4mind/common';
import {
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  userRepository,
  orgDomainClaimRepository,
  withTransaction,
} from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { groupRepository } from '@bike4mind/database/social';
import { organizationService } from '@bike4mind/services';
import { lakeConfigAuditDb } from '../dataLakes/lakeConfigAuditDb';
import { SubscriptionOwnerType, SubscriptionSource } from '../lib/subscriptions/types';
import { subscriptionRepository } from '../models/Subscription';
import { resolveSubscriptionSource } from '../services/organizationService';
import { clearDeletedOrganizationReferences } from '../organizations/clearDeletedOrganizationReferences';
import { NotFoundError } from '../utils/errors';

export type OwnedOrganization = { id: string; name: string };

type DeletionLogger = Parameters<typeof organizationService.deleteOrganization>[2]['logger'] & {
  info: (message: string) => void;
  warn: (message: string) => void;
};

type OwnedOrganizations = {
  /** Owned organizations someone else belongs to; these must be transferred before the owner can go. */
  shared: OwnedOrganization[];
  /** Owned organizations where the owner is the only member; erasure deletes them. */
  solo: OwnedOrganization[];
};

// The owner is not a `users[]` row, so any row or role-list entry that is not the owner is another person.
// Deliberately counts rows that do not confer membership: refusing is safe, deleting someone's org is not.
const hasOtherMembers = (
  org: Pick<IOrganizationDocument, 'users' | 'adminUserIds' | 'billingManagerUserIds'>,
  ownerId: string
): boolean =>
  (org.users ?? []).some(row => String(row.userId) !== ownerId) ||
  [...(org.adminUserIds ?? []), ...(org.billingManagerUserIds ?? [])].some(id => String(id) !== ownerId);

/** The organizations the user is billing owner of, split by whether anyone else belongs to them. */
export async function classifyOwnedOrganizations(userId: string): Promise<OwnedOrganizations> {
  const orgs = await organizationRepository.find({ userId, deletedAt: null, personal: { $ne: true } });
  const result: OwnedOrganizations = { shared: [], solo: [] };
  for (const org of orgs) {
    (hasOtherMembers(org, userId) ? result.shared : result.solo).push({ id: String(org.id), name: org.name });
  }
  return result;
}

/**
 * Deletes every owned organization the user is the only member of, one transaction each, through the
 * same service as the organization DELETE route. An organization someone joined since the check is
 * left in place for the caller's final guard to refuse. Idempotent: deleted organizations no longer match.
 */
export async function deleteSoleOwnedOrganizations(
  userId: string,
  { logger, assertLease }: { logger: DeletionLogger; assertLease?: () => Promise<void> }
): Promise<OwnedOrganization[]> {
  const owner = await userRepository.findById(userId);
  if (!owner) throw new NotFoundError('User not found');

  const { solo } = await classifyOwnedOrganizations(userId);
  const deleted: OwnedOrganization[] = [];
  for (const org of solo) {
    await assertLease?.();
    // Stripe subscriptions were cancelled when deletion was scheduled, so the route's active-subscription
    // validation is not applied here. An admin grant has no Stripe customer and that cancel never reaches
    // it, so it is closed here in the delete's transaction, the same way the admin revoke does.
    const removed = await withTransaction(async () => {
      const current = (await organizationRepository.findById(org.id)) as WithId<IOrganizationDocument> | null;
      if (!current || String(current.userId) !== userId || hasOtherMembers(current, userId)) return false;
      const activeSubscriptions = await subscriptionRepository.findActiveSubscriptionsByOwner(
        SubscriptionOwnerType.Organization,
        org.id
      );
      for (const subscription of activeSubscriptions) {
        if (resolveSubscriptionSource(subscription) !== SubscriptionSource.AdminGrant) continue;
        await subscriptionRepository.update({ id: subscription.id, status: 'canceled', canceledAt: new Date() });
      }
      await organizationService.deleteOrganization(
        owner,
        { id: org.id },
        {
          db: {
            organizations: organizationRepository,
            groups: groupRepository,
            users: userRepository,
            dataLakes: dataLakeRepository,
            dataLakeAccessGrants: dataLakeAccessGrantRepository,
            ...lakeConfigAuditDb,
          },
          logger,
        }
      );
      await orgDomainClaimRepository.deleteByOrganization(org.id);
      return true;
    });
    if (!removed) continue;
    deleted.push(org);
    await clearDeletedOrganizationReferences(org.id, logger);
    logger.info(`[AccountDeletion] Deleted sole-owner organization ${org.id} for user ${userId}`);
  }
  return deleted;
}
