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
import { lakeConfigWriteStamp } from './lakeConfigWriteStamp';

interface TransferLakeOwnershipAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake' | 'upsertGrant'>;
    users: Pick<IUserRepository, 'findById'>;
    organizations: Pick<IOrganizationRepository, 'findById'>;
  };
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
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
 * CONSENT GUARD (#1668 review B4): an actor authorized SOLELY by the org-admin rung - not the
 * effective owner, not a platform admin - may NOT name THEMSELVES as the new owner. Succession is a
 * reassignment to ANOTHER member, not a self-grab: without this an org admin could transfer a lake to
 * self and then use `setLakeVisibility`'s expose gate (which is `isEffectiveOwner`, precisely so an
 * admin cannot expose a lake without the owner consenting) to publish it - routing around the very
 * invariant that gate documents. Reassigning to another member is fine: the recipient is then a real
 * owner exposing their own lake. A platform admin is unconstrained (global superuser by definition).
 *
 * Refused for a fallback (hardcoded registry) lake, which has no backing document to hang a grant on
 * (`assertLakeGrantable`). For an org-scoped lake the new owner must belong to that org - membership
 * never crosses organizations (epic decision 12).
 */
export const transferLakeOwnership = async (
  actor: ManageActor,
  dataLakeId: string,
  newOwnerUserId: string,
  { db, logger }: TransferLakeOwnershipAdapters
): Promise<TransferLakeOwnershipResult> => {
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) {
    throw new NotFoundError('Data lake not found');
  }
  // Fallback lakes have no document and no createdByUserId to seed from - grants are refused.
  assertLakeGrantable(lake);

  const grants = await loadActiveLakeGrants(lake, { db });
  const lakeOrg = normalizeId(lake.organizationId);
  const isOwner = isEffectiveOwner(lake, actor, grants);
  const isOrgAdminOfLake = !!lakeOrg && (actor.administeredOrgIds ?? []).includes(lakeOrg);
  if (!(actor.isAdmin || isOwner || isOrgAdminOfLake)) {
    throw new BadRequestError('You do not have permission to transfer ownership of this data lake');
  }
  // Consent guard (see doc above): an org admin acting purely by the org-admin rung may reassign the
  // lake to another member, but may not grab ownership for themselves and then expose it around the
  // owner-only expose gate. A platform admin or the current owner is exempt.
  if (!actor.isAdmin && !isOwner && newOwnerUserId === actor.userId) {
    throw new BadRequestError('An organization admin cannot transfer a data lake to themselves; name another member.');
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

  // Ownership lives in the grants, not on the document, so this is the one config write that would
  // otherwise leave the lake itself untouched - and a transfer is the change most worth attributing.
  // Written AFTER the grants so the stamp never claims a transfer that failed partway. The grant
  // rows carry `grantedByUserId` independently; this keeps the lake's own "who last changed me"
  // answer true rather than pointing at an older, smaller edit.
  // Guarded, unlike the other call sites: this write exists ONLY to carry the stamp, so an
  // unattributable actor would otherwise cost a round trip that sets nothing.
  //
  // Best-effort for the same reason it is ordered last: the grants above have already moved
  // ownership, so throwing here would report a failed transfer that in fact succeeded and invite a
  // retry of an operation that is done. An audit write must never fail the operation it audits -
  // but it must not fail SILENTLY either, since the only other symptom is a stamp that quietly
  // names an older, smaller edit.
  const stamp = lakeConfigWriteStamp(actor);
  if (stamp.lastUpdatedByUserId) {
    try {
      await db.dataLakes.update({ id: lake.id, ...stamp });
    } catch (err) {
      logger?.warn('[dataLakes] ownership transferred but the actor stamp did not persist', {
        dataLakeId: lake.id,
        err,
      });
    }
  }

  return { newOwnerUserId, demotedUserIds };
};
