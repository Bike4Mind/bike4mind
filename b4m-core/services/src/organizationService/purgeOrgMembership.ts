import { IGroupRepository, IUserRepository } from '@bike4mind/common';

interface PurgeOrgMembershipAdapters {
  db: {
    groups: Pick<IGroupRepository, 'findByOrganization'>;
    users: Pick<IUserRepository, 'removeGroupsFromUser'>;
  };
}

/**
 * Strip an org's footprint from a member who is leaving or being removed. Shared by `leave`
 * (voluntary) and `revokeAccess` (involuntary) so the group-id + admin purge stays in one place:
 *   - pull the org's live group ids from the member's `user.groups[]` (a real DB write), AND
 *   - compute `adminUserIds` with the member removed and RETURN it.
 *
 * Neither `user.groups[]` nor `adminUserIds` carries an org qualifier, so a member who keeps them
 * after removal retains both group-shared data access and org-admin authority. (`assertCanManageOrgGroups`
 * also requires current org membership, not just `adminUserIds` - but that check reads
 * `organization.users`, which THIS purge doesn't touch, so it is not a substitute for pruning
 * `adminUserIds` here.)
 *
 * Returns the pruned `adminUserIds` rather than mutating in place and returning void: the caller
 * MUST assign it onto the org doc it persists, so a future caller cannot silently get the unsafe
 * half (group access dropped, admin authority retained). Idempotent - safe under a withTransaction
 * retry. NOTE: clearing the departing member's selected `organizationId` is NOT part of this shared
 * step - `leave` and `revokeAccess` each do it themselves, because they hold the member's document
 * at different points (leave has the acting user, revoke must fetch the target).
 */
export async function purgeOrgMembershipArtifacts(
  targetUserId: string,
  organization: { id: string; adminUserIds?: string[] },
  adapters: PurgeOrgMembershipAdapters
): Promise<string[]> {
  const orgGroups = await adapters.db.groups.findByOrganization(organization.id);
  await adapters.db.users.removeGroupsFromUser(
    targetUserId,
    orgGroups.map(group => group.id)
  );
  return (organization.adminUserIds ?? []).filter(id => id !== targetUserId);
}
