import { IGroupRepository, IUserRepository } from '@bike4mind/common';
import {
  lapseDepartedMemberLakeAccess,
  type LakeAccessLapseTrigger,
  type LapseDepartedMemberLakeAccessAdapters,
  type LapsingOrganization,
} from '../dataLakeService';

export interface PurgeOrgMembershipAdapters extends LapseDepartedMemberLakeAccessAdapters {
  db: LapseDepartedMemberLakeAccessAdapters['db'] & {
    groups: Pick<IGroupRepository, 'findByOrganization'>;
    users: Pick<IUserRepository, 'removeGroupsFromUser'>;
  };
}

/**
 * Strip an org's footprint from a member who is leaving or being removed. Shared by the two
 * single-member departure paths - `leave` (voluntary) and `revokeAccess` (involuntary) - so those
 * two cannot drift apart. Whole-org teardown does NOT route through here: `deleteOrganization`
 * ends every membership at once without calling this, so grants in a deleted org stay active. That
 * is deliberate for now (it is a soft delete, and hard-expiring rows on a restorable operation is
 * a separate, destructive decision) but it does mean this is not yet the only departure seam.
 * What it does, for one departing member:
 *   - pull the org's live group ids from the member's `user.groups[]` (a real DB write),
 *   - end the member's data-lake access on this org's lakes, passing on ownership of any lake they
 *     created so it does not fall back to them (a real DB write), AND
 *   - compute `adminUserIds` with the member removed and RETURN it.
 *
 * Neither `user.groups[]` nor `adminUserIds` carries an org qualifier, so a member who keeps them
 * after removal retains both group-shared data access and org-admin authority. (`assertCanManageOrgGroups`
 * also requires current org membership, not just `adminUserIds` - but that check reads
 * `organization.users`, which THIS purge doesn't touch, so it is not a substitute for pruning
 * `adminUserIds` here.)
 *
 * Lake access belongs here for the same reason: grants carry no membership qualifier either, so a
 * role held on one of this org's lakes outlived the membership it was issued for. Putting the step
 * in this shared place (rather than in each caller) is what stops the two departure paths from
 * drifting apart, exactly as for the group purge. The lake adapters are REQUIRED, not optional, so
 * a future caller cannot silently opt out of the revocation half.
 *
 * Takes the whole `organization` rather than its id because the lake step needs the billing owner
 * (`organization.userId`) as the successor for a lake the departing member created.
 *
 * Returns the pruned `adminUserIds` rather than mutating in place and returning void: the caller
 * MUST assign it onto the org doc it persists, so a future caller cannot silently get the unsafe
 * half (group access dropped, admin authority retained). Idempotent - safe under a withTransaction
 * retry, including both halves of the lake step - by two different mechanisms, so both are worth
 * stating: a retry's `listByPrincipal(..., { activeAsOf })` no longer matches the row phase 1 just
 * expired, so it re-stamps nothing; and the successor grant phase 2 wrote makes phase 2's "another
 * active owner already exists" guard true, so ownership passes on exactly once. Neither half
 * records a duplicate audit event.
 *
 * NOTE: clearing the departing member's selected `organizationId` is NOT part of this shared
 * step - `leave` and `revokeAccess` each do it themselves, because they hold the member's document
 * at different points (leave has the acting user, revoke must fetch the target).
 */
export async function purgeOrgMembershipArtifacts(
  targetUserId: string,
  organization: LapsingOrganization & { adminUserIds?: string[] },
  triggeredBy: LakeAccessLapseTrigger,
  adapters: PurgeOrgMembershipAdapters
): Promise<string[]> {
  const orgGroups = await adapters.db.groups.findByOrganization(organization.id);
  await adapters.db.users.removeGroupsFromUser(
    targetUserId,
    orgGroups.map(group => group.id)
  );
  await lapseDepartedMemberLakeAccess(targetUserId, organization, triggeredBy, adapters);
  return (organization.adminUserIds ?? []).filter(id => id !== targetUserId);
}
