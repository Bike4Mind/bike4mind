import { IGroupRepository, IUserRepository } from '@bike4mind/common';

interface PurgeOrgMembershipAdapters {
  db: {
    groups: Pick<IGroupRepository, 'findByOrganization'>;
    users: Pick<IUserRepository, 'removeGroupsFromUser'>;
  };
}

/**
 * Strip an org's footprint from a member who is leaving or being removed. Shared by `leave`
 * (voluntary) and `revokeAccess` (involuntary) so both paths stay in sync:
 *   - pull the org's live group ids from the member's `user.groups[]`, AND
 *   - drop the member from `organization.adminUserIds`.
 *
 * Neither `user.groups[]` nor `adminUserIds` carries an org qualifier, so a member who keeps them
 * after removal retains both group-shared data access and org-admin authority
 * (`assertCanManageOrgGroups` only checks `adminUserIds`). `adminUserIds` is mutated in place on
 * the passed `organization`; the caller persists the org doc it is already writing. Every step is
 * idempotent, so this is safe to re-run under a `withTransaction` retry.
 */
export async function purgeOrgMembershipArtifacts(
  targetUserId: string,
  organization: { adminUserIds?: string[] },
  organizationId: string,
  adapters: PurgeOrgMembershipAdapters
): Promise<void> {
  const orgGroups = await adapters.db.groups.findByOrganization(organizationId);
  await adapters.db.users.removeGroupsFromUser(
    targetUserId,
    orgGroups.map(group => group.id)
  );
  organization.adminUserIds = (organization.adminUserIds ?? []).filter(id => id !== targetUserId);
}
