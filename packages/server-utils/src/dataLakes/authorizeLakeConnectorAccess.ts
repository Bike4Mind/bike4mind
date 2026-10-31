import { lakeConnectionOwnerForLake, type LakeConnectionOwner } from '@bike4mind/common';
import { verifyOrgAccess, verifyOrgAdminRead } from '../utils/orgAccess';
import { NotFoundError } from '../utils/errors';

type LakeConnectorAccessUser = { id: string; isAdmin: boolean };
type LakeConnectorAccessLake = { organizationId?: string | null; createdByUserId: string };

/** Only a personal lake's creator passes - a 404 for anyone else, like an org refusal. */
function assertPersonalLakeCreator(owner: { userId: string }, user: LakeConnectorAccessUser) {
  if (owner.userId !== user.id) {
    throw new NotFoundError('Data lake not found');
  }
}

/**
 * Gate a caller on managing a lake's connector connection (Google Drive folder, GitHub repository);
 * returns the owner that connection must have.
 *
 * An org lake needs an org owner/manager (or platform admin): its connection keeps syncing for the org
 * and other managers can operate it. A personal lake needs its creator and nobody else - not even a
 * platform admin - because the ingest writes its membership as that user (a Drive connection also
 * syncs on their own Google grant). A refusal is a 404 like verifyOrgAccess's, so a lake id cannot be
 * probed.
 *
 * Shared by every connector's connect and manage doors (drive-sync, drive-connection, github-connect,
 * github-connection) so they cannot drift apart.
 */
export async function authorizeLakeConnectorAccess(
  user: LakeConnectorAccessUser,
  lake: LakeConnectorAccessLake
): Promise<LakeConnectionOwner> {
  const owner = lakeConnectionOwnerForLake(lake);
  if (owner.kind === 'organization') {
    await verifyOrgAccess(user, owner.organizationId);
  } else {
    assertPersonalLakeCreator(owner, user);
  }
  return owner;
}

/**
 * Read-tier twin of authorizeLakeConnectorAccess for the connection STATUS read only: an org lake also
 * admits an appointed org admin, who can already manage the lake itself. `canManage` says whether the
 * caller passes the write gate, so the client can offer connect/re-sync/disconnect only to who may use
 * them. A personal lake is unchanged - its creator only, who always manages it.
 */
export async function authorizeLakeConnectorRead(
  user: LakeConnectorAccessUser,
  lake: LakeConnectorAccessLake
): Promise<{ owner: LakeConnectionOwner; canManage: boolean }> {
  const owner = lakeConnectionOwnerForLake(lake);
  if (owner.kind === 'organization') {
    const { canManage } = await verifyOrgAdminRead(user, owner.organizationId);
    return { owner, canManage };
  }
  assertPersonalLakeCreator(owner, user);
  return { owner, canManage: true };
}
