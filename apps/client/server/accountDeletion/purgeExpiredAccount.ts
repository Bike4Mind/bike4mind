import { realtimeConnectionRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { hardDeleteUser } from '@server/services/hardDeleteUser';
import { deleteOrganizationCascade } from '@server/organizations/deleteOrganizationCascade';
import { classifyOwnedOrganizations } from './ownedOrganizations';

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/** `not_due`: gone already, restored, or requested after the cutoff. `org_has_members`: left pending for a human. */
export type ExpiredAccountOutcome = 'deleted' | 'not_due' | 'org_has_members';

/**
 * Hard-deletes one account whose self-service deletion grace period ended at or before `cutoff`: its
 * sole-member organizations first (through the org delete path), then the account (through the admin
 * delete path, hardDeleteUser). Re-checks the account first, so a restore that lands after the sweep's
 * scan wins. Safe to re-run: a deleted account is not found again, and a deleted org is not listed again.
 */
export async function purgeExpiredAccount(
  userId: string,
  { cutoff, logger }: { cutoff: Date; logger: MinimalLogger }
): Promise<ExpiredAccountOutcome> {
  const user = await userRepository.findById(userId);
  if (!user?.deletionRequestedAt || new Date(user.deletionRequestedAt) > cutoff) return 'not_due';

  // The request was refused while the user owned a shared org, so this means someone joined one during
  // the grace period (an admin added them). Deleting the owner would strand them; a human decides.
  const { shared, soleMember } = await classifyOwnedOrganizations(userId);
  if (shared.length > 0) {
    logger.error(
      `[AccountDeletion] Not deleting user ${userId}: they own organization(s) with other members (${shared
        .map(org => org.id)
        .join(', ')})`
    );
    return 'org_has_members';
  }

  for (const org of soleMember) {
    await deleteOrganizationCascade(user, org.id, { logger });
  }

  await hardDeleteUser(userId, { deletedBy: userId, initiatedBy: 'self', logger }, users =>
    userService.deleteUserAccount(userId, { db: { users, realtimeConnections: realtimeConnectionRepository } })
  );
  logger.info(`[AccountDeletion] Deleted user ${userId} and ${soleMember.length} sole-member organization(s)`);
  return 'deleted';
}
