import {
  IGroupRepository,
  IOrganizationRepository,
  IUserRepository,
  unknownGroupTypeKeys,
  getGroupType,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

interface SetGroupTypesAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById' | 'update'>;
    groups: Pick<IGroupRepository, 'findByOrganization' | 'createIfMissing' | 'softDeleteByIds'>;
    users: Pick<IUserRepository, 'removeGroupsFromAllUsers'>;
  };
  logger?: { info: (message: string) => void };
}

export interface SetGroupTypesResult {
  added: string[];
  removed: string[];
  revokedGroupIds: string[];
}

/**
 * Set an organization's allowed group types - a platform-admin action (org-groups #1172, Phase 3).
 *
 * - Validates every requested key against the code-defined catalog (a typo can't persist a dead grant).
 * - Rejects personal organizations (agreed decision 4).
 * - Provisions a `Group` instance for each newly-allowed type that has none yet (idempotent - groups
 *   are created only here, never directly).
 * - For each revoked type: soft-deletes its instance(s) AND purges those group ids from every
 *   member's `user.groups`. This is the org-wide analog of the leave.ts purge - without it, a
 *   revoked type would leave members holding access to a group that no longer exists.
 *
 * Callers MUST wrap this in a transaction: the group soft-deletes, the member purge, and the org
 * write have to commit together, or a partial failure leaves dangling membership.
 */
export async function setOrganizationGroupTypes(
  { organizationId, allowedGroupTypes }: { organizationId: string; allowedGroupTypes: string[] },
  adapters: SetGroupTypesAdapters
): Promise<SetGroupTypesResult> {
  const { db, logger } = adapters;

  const requested = [...new Set(allowedGroupTypes.map(key => key.trim()).filter(Boolean))];
  const unknown = unknownGroupTypeKeys(requested);
  if (unknown.length > 0) {
    throw new BadRequestError(`Unknown group type(s): ${unknown.join(', ')}`);
  }

  const organization = await db.organizations.findById(organizationId);
  if (!organization) throw new NotFoundError('Organization not found');
  if (organization.personal) {
    throw new BadRequestError('Personal organizations cannot be granted group types');
  }

  const current = organization.allowedGroupTypes ?? [];
  const added = requested.filter(type => !current.includes(type));
  const removed = current.filter(type => !requested.includes(type));

  const liveGroups = await db.groups.findByOrganization(organizationId);
  const typesWithInstance = new Set(liveGroups.map(group => group.type));

  // Provision a group instance for every allowed type that lacks one (idempotent). Iterate
  // `requested`, not `added`: iterating only newly-added types leaves no way to repair an org
  // that holds a type with no live group (e.g. a prior revoke that soft-deleted the instance but
  // whose member purge was lost). Re-issuing the same PUT now re-provisions the missing group.
  // createIfMissing (not create): two overlapping grant PUTs can both reach this loop with the
  // same missing type - the loser would otherwise hit the group_org_type_live unique index and
  // 500 (org-groups #1222). createIfMissing treats that collision as success.
  for (const type of requested) {
    if (typesWithInstance.has(type)) continue;
    const def = getGroupType(type)!; // safe: requested keys were validated against the catalog above
    await db.groups.createIfMissing({ name: def.label, description: def.description, type, organizationId });
  }

  // Revoke: purge the ids from all members, then soft-delete the instances of removed types.
  // Members first for the same reason as organizationService/delete.ts: user.groups[] is the
  // access-bearing artifact (the sharing layer's `groups.$elemMatch.groupId $in user.groups` match
  // still succeeds against a soft-deleted group's id), so it is the one that must go first. Both
  // orders are equivalent while this runs in a transaction, but the two paths should not disagree
  // about which write carries the access.
  const revokedGroupIds = liveGroups.filter(group => removed.includes(group.type)).map(group => group.id);
  if (revokedGroupIds.length > 0) {
    await db.users.removeGroupsFromAllUsers(revokedGroupIds);
    await db.groups.softDeleteByIds(revokedGroupIds);
  }

  await db.organizations.update({ id: organizationId, allowedGroupTypes: requested });
  logger?.info(
    `Organization ${organizationId} allowed group types updated ` +
      `(added: [${added.join(', ')}], removed: [${removed.join(', ')}])`
  );

  return { added, removed, revokedGroupIds };
}
