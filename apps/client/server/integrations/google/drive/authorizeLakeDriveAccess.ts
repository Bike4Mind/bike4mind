import { driveConnectionOwnerForLake, type DriveConnectionOwner } from '@bike4mind/common';
import { verifyOrgAccess, verifyOrgAdminRead } from '@server/utils/orgAccess';
import { NotFoundError } from '@server/utils/errors';

type LakeDriveAccessUser = { id: string; isAdmin: boolean };
type LakeDriveAccessLake = { organizationId?: string | null; createdByUserId: string };

/** A personal lake's connection syncs on its creator's own Google grant, so nobody else passes - a 404, like an org refusal. */
function assertPersonalLakeCreator(owner: { userId: string }, user: LakeDriveAccessUser) {
  if (owner.userId !== user.id) {
    throw new NotFoundError('Data lake not found');
  }
}

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
  user: LakeDriveAccessUser,
  lake: LakeDriveAccessLake
): Promise<DriveConnectionOwner> {
  const owner = driveConnectionOwnerForLake(lake);
  if (owner.kind === 'organization') {
    await verifyOrgAccess(user, owner.organizationId);
  } else {
    assertPersonalLakeCreator(owner, user);
  }
  return owner;
}

/**
 * Read-tier twin of authorizeLakeDriveAccess for the connection STATUS read only: an org lake also
 * admits an appointed org admin, who can already manage the lake itself. `canManage` says whether the
 * caller passes the write gate, so the client can offer connect/re-sync/disconnect only to who may use
 * them. A personal lake is unchanged - its creator only, who always manages it.
 */
export async function authorizeLakeDriveRead(
  user: LakeDriveAccessUser,
  lake: LakeDriveAccessLake
): Promise<{ owner: DriveConnectionOwner; canManage: boolean }> {
  const owner = driveConnectionOwnerForLake(lake);
  if (owner.kind === 'organization') {
    const { canManage } = await verifyOrgAdminRead(user, owner.organizationId);
    return { owner, canManage };
  }
  assertPersonalLakeCreator(owner, user);
  return { owner, canManage: true };
}
