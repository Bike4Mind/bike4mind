import { IGroupRepository, IOrganizationRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { purgeOrgMembershipArtifacts, type PurgeOrgMembershipAdapters } from './purgeOrgMembership';
import { canAdministerOrganization, isCurrentOrgMember } from './orgAuthority';

const revokeAccessSchema = z.object({
  id: z.string(),
  userId: z.string(),
});

type RevokeAccessParameters = z.infer<typeof revokeAccessSchema>;

interface RevokeAccessAdapters extends PurgeOrgMembershipAdapters {
  db: PurgeOrgMembershipAdapters['db'] & {
    organizations: IOrganizationRepository;
    groups: Pick<IGroupRepository, 'findByOrganization'>;
    users: Pick<IUserRepository, 'removeGroupsFromUser' | 'findById' | 'update'>;
  };
}

/**
 * Revokes access to an organization for a user
 * @param user - The user to revoke access for
 * @param parameters - The parameters for the revoke access operation
 * @param adapters - The adapters for the database operations
 */
export const revokeAccess = async (
  user: IUserDocument,
  parameters: RevokeAccessParameters,
  adapters: RevokeAccessAdapters
) => {
  const { id, userId } = secureParameters(parameters, revokeAccessSchema);

  const organization = await adapters.db.organizations.findById(id);
  if (!organization) throw new NotFoundError(`Organization not found for id: ${id}`);

  // Only owner, manager, or admin can revoke access. Shares the predicate with addMember so the
  // two halves of the membership lifecycle cannot drift on who may change the roster.
  if (!canAdministerOrganization(user, organization)) {
    throw new NotFoundError(`Organization not found for id: ${id}`); // Return same error to avoid info leakage
  }

  // The billing owner is not a removable member, and must be refused BEFORE the membership check
  // below - `isCurrentOrgMember` admits them (they are attached to the org), so without this they
  // reach the purge. Nothing here clears `organization.userId`, so the removal cannot actually end
  // their relationship to the org: they would keep the owner pointer, and with it every rung
  // `findIdsWithAdminRights` grants, while the purge expired their grants on the org's own lakes.
  // On a lake whose ownership had been transferred away from its creator that is worse than a
  // no-op - `resolveEffectiveOwnerIds` falls back to `createdByUserId`, handing effective ownership
  // to the original creator. Mirrors `leave`, which has always refused the same principal ("Cannot
  // leave your own organization"); ending a billing owner's tenure is an ownership transfer, not a
  // roster edit. Stated plainly rather than as a not-found: the actor is already an authorized
  // administrator here, so there is no existence to leak, and the org owner is not a secret.
  if (organization.userId === userId) {
    throw new BadRequestError(
      'Cannot remove the organization owner; transfer organization ownership first, then remove them.'
    );
  }

  // The target must actually be a member. The filter below is a no-op for a non-member, which was
  // harmless while nothing downstream acted on the removal - but the purge now expires data-lake
  // grants, so without this an org admin could pass ANY userId and lapse that user's grants on this
  // org's lakes, member or not. That is also what makes `lapseDepartedMemberLakeAccess`' "a curator
  // who was never a member of this org triggers no departure here" true of the path rather than
  // merely of the primitive. Same error as the authority failure above, to avoid leaking whether a
  // given account exists or belongs here.
  if (!isCurrentOrgMember(organization, userId)) {
    throw new NotFoundError(`Organization not found for id: ${id}`);
  }

  organization.users = organization.users.filter(user => user.userId.toString() !== userId);

  organization.userDetails ||= [];
  organization.userDetails = organization.userDetails.filter(user => user.id.toString() !== userId);

  // Mirror leave.ts: an involuntarily-removed member must not keep the org's group ids (data
  // access), their data-lake access on this org's lakes, a seat in adminUserIds, or the manager
  // appointment (both of those are org-admin authority - assertCanManageOrgGroups reads the first,
  // findIdsWithAdminRights reads both). Involuntary removal is exactly where retained access
  // matters most. Idempotent under retry. The whole org doc goes in because the lake step needs the
  // billing owner to pass a departed creator's lakes on to; the lapse is attributed to the REMOVING
  // admin, the principal whose action ended the access.
  const purged = await purgeOrgMembershipArtifacts(userId, organization, { userId: user.id }, adapters);
  organization.adminUserIds = purged.adminUserIds;
  organization.managerId = purged.managerId;

  await adapters.db.organizations.update(organization);

  // Mirror leave.ts: if the org we just removed them from was the user's currently-selected org,
  // clear it - otherwise org-scoped access (data-lake AccessContext, team-wide prompts) and billing
  // keep being inferred from a stale organizationId, the inverse of the join-side invariant set in
  // acceptOrganization/addMember. We hold only the removed user's id here, so fetch them to compare.
  // Idempotent under a withTransaction retry (a re-run recomputes the same set-to-null).
  const removed = await adapters.db.users.findById(userId);
  if (removed?.organizationId?.toString() === id) {
    await adapters.db.users.update({ id: userId, organizationId: null });
  }

  return organization;
};
