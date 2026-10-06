import { driveConnectionOwnerForLake, type DriveConnectionOwner } from '@bike4mind/common';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { NotFoundError } from '@server/utils/errors';

/**
 * Gate a caller on managing a lake's Drive connection; returns the owner that connection must have.
 *
 * An org lake needs an org owner/manager (or platform admin): its connection carries an org-owned
 * credential copy that keeps polling and that other managers can operate. A personal lake needs its
 * creator and nobody else - not even a platform admin - because its connection syncs on the caller's
 * own Google grant. A refusal is a 404 like verifyOrgAccess's, so a lake id cannot be probed.
 *
 * Shared by drive-sync and drive-connection so the connect and manage doors cannot drift apart.
 */
export async function authorizeLakeDriveAccess(
  user: { id: string; isAdmin: boolean },
  lake: { organizationId?: string | null; createdByUserId: string }
): Promise<DriveConnectionOwner> {
  const owner = driveConnectionOwnerForLake(lake);
  if (owner.kind === 'organization') {
    await verifyOrgAccess(user, owner.organizationId);
  } else if (owner.userId !== user.id) {
    throw new NotFoundError('Data lake not found');
  }
  return owner;
}
