import type { IOrganizationDocument, WithId } from '@bike4mind/common';
import {
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { groupRepository } from '@bike4mind/database/social';
import { organizationService } from '@bike4mind/services';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { clearDeletedOrganizationReferences } from '@server/organizations/clearDeletedOrganizationReferences';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';

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

// The owner is not a `users[]` row, so any row or manager entry that is not the owner is another person.
// Deliberately counts rows that do not confer membership: refusing is safe, deleting someone's org is not.
const hasOtherMembers = (org: Pick<IOrganizationDocument, 'users' | 'adminUserIds'>, ownerId: string): boolean =>
  (org.users ?? []).some(row => String(row.userId) !== ownerId) ||
  (org.adminUserIds ?? []).some(id => String(id) !== ownerId);

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
    // Subscriptions were cancelled when deletion was scheduled, so the route's active-subscription
    // validation is not applied here.
    await withTransaction(async () => {
      const current = (await organizationRepository.findById(org.id)) as WithId<IOrganizationDocument> | null;
      if (!current || hasOtherMembers(current, userId)) return;
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
      deleted.push(org);
    });
  }
  for (const org of deleted) {
    await clearDeletedOrganizationReferences(org.id, logger);
    logger.info(`[AccountDeletion] Deleted sole-owner organization ${org.id} for user ${userId}`);
  }
  return deleted;
}
