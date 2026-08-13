import type {
  IDataLakeAccessGrantRepository,
  IDataLakeRepository,
  IOrganizationRepository,
  IUserRepository,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError, normalizeId } from '@bike4mind/utils';
import { isEffectiveOwner, resolveEffectiveOwnerIds, type ManageActor } from './manageRule';
import { assertLakeGrantable } from './assertLakeAccess';
import { loadActiveLakeGrants } from './authorizeLakeManage';

interface TransferLakeOwnershipAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake' | 'upsertGrant'>;
    users: Pick<IUserRepository, 'findById'>;
    organizations: Pick<IOrganizationRepository, 'findById'>;
  };
}

export interface TransferLakeOwnershipResult {
  newOwnerUserId: string;
  /** Prior effective owners demoted to curator by this transfer (empty when it was a no-op). */
  demotedUserIds: string[];
}

/**
 * Transfer a lake's ownership to another user WITHOUT mutating `createdByUserId` (which stays the
 * immutable creator/provenance identity and the membership prefix-arm anchor). Ownership is carried
 * by an `owner`-role access grant: this upserts one for the new owner, so `resolveEffectiveOwnerIds`
 * now returns them, and demotes each prior effective owner to `curator` - they keep management
 * access (reversible), just not ownership. When the lake had no owner grant yet (ownership was the
 * `createdByUserId` fallback), the creator is the demoted party, so they retain access as a curator.
 *
 * Authorization is deliberately NARROWER than `canManageLake`: only a platform admin, the current
 * effective owner, or an admin of the lake's org (the orphaned-creator succession path) may transfer
 * - a curator manages but does not own, so cannot hand ownership away.
 *
 * Refused for a fallback (hardcoded registry) lake, which has no backing document to hang a grant on
 * (`assertLakeGrantable`). For an org-scoped lake the new owner must belong to that org - membership
 * never crosses organizations (epic decision 12).
 */
export const transferLakeOwnership = async (
  actor: ManageActor,
  dataLakeId: string,
  newOwnerUserId: string,
  { db }: TransferLakeOwnershipAdapters
): Promise<TransferLakeOwnershipResult> => {
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) {
    throw new NotFoundError('Data lake not found');
  }
  // Fallback lakes have no document and no createdByUserId to seed from - grants are refused.
  assertLakeGrantable(lake);

  const grants = await loadActiveLakeGrants(lake, { db });
  const lakeOrg = normalizeId(lake.organizationId);
  const isOrgAdminOfLake = !!lakeOrg && (actor.administeredOrgIds ?? []).includes(lakeOrg);
  if (!(actor.isAdmin || isEffectiveOwner(lake, actor, grants) || isOrgAdminOfLake)) {
    throw new BadRequestError('You do not have permission to transfer ownership of this data lake');
  }

  const newOwner = await db.users.findById(newOwnerUserId);
  if (!newOwner) {
    throw new BadRequestError('The chosen new owner could not be found');
  }

  // Org-scoped lake: the new owner must be a member of the owning org (billing owner, appointed
  // admin, or on the users[] ACL). Membership never crosses organizations, so an out-of-org target
  // is refused rather than silently granted.
  if (lakeOrg) {
    const org = await db.organizations.findById(lakeOrg);
    const isMember =
      !!org &&
      (org.userId === newOwnerUserId ||
        (org.adminUserIds ?? []).includes(newOwnerUserId) ||
        (org.users ?? []).some(member => member.userId === newOwnerUserId));
    if (!isMember) {
      throw new BadRequestError('The new owner must belong to the organization that owns this data lake');
    }
  }

  const priorOwners = resolveEffectiveOwnerIds(lake, grants);

  await db.dataLakeAccessGrants.upsertGrant({
    dataLakeId: lake.id,
    principalType: 'user',
    principalId: newOwnerUserId,
    role: 'owner',
    grantedByUserId: actor.userId,
    // Ownership never expires; clear any prior expiry a lapsed grant on this principal carried.
    expiresAt: null,
  });

  const demotedUserIds: string[] = [];
  for (const priorOwnerUserId of priorOwners) {
    if (priorOwnerUserId === newOwnerUserId) continue;
    await db.dataLakeAccessGrants.upsertGrant({
      dataLakeId: lake.id,
      principalType: 'user',
      principalId: priorOwnerUserId,
      role: 'curator',
      grantedByUserId: actor.userId,
      expiresAt: null,
    });
    demotedUserIds.push(priorOwnerUserId);
  }

  return { newOwnerUserId, demotedUserIds };
};
