import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { IGroupRepository, IOrganizationRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { purgeOrgMembershipArtifacts, type PurgeOrgMembershipAdapters } from './purgeOrgMembership';

const organizationLeaveSchema = z.object({
  id: z.string(),
});

type OrganizationLeaveParameters = z.infer<typeof organizationLeaveSchema>;

interface OrganizationLeaveAdapters extends PurgeOrgMembershipAdapters {
  db: PurgeOrgMembershipAdapters['db'] & {
    organizations: IOrganizationRepository;
    users: Pick<IUserRepository, 'update' | 'removeGroupsFromUser'>;
    groups: Pick<IGroupRepository, 'findByOrganization'>;
  };
}

/**
 * Leaves an organization
 *
 * @param user - The user to leave the organization
 * @param parameters - The parameters for the leave operation
 * @param adapters - The adapters for the database operations
 * @returns The organization after leaving
 */
export const leave = async (
  user: IUserDocument,
  parameters: OrganizationLeaveParameters,
  adapters: OrganizationLeaveAdapters
) => {
  const { id } = secureParameters(parameters, organizationLeaveSchema);

  const organization = await adapters.db.organizations.shareable.findAccessibleById(user, id);
  if (!organization) throw new NotFoundError(`Organization not found for id: ${id}`);
  if (organization.userId === user.id) throw new BadRequestError('Cannot leave your own organization');

  organization.users = organization.users.filter(u => u.userId !== user.id);
  organization.userDetails = organization.userDetails?.filter(u => u.id !== user.id) ?? [];

  // Strip this org's group ids from the departing user, end their data-lake access on this org's
  // lakes, and drop them from adminUserIds and from the manager appointment (the org doc, persisted
  // just below). None of `user.groups[]`, the grant rows, `adminUserIds` or `managerId` carries an
  // org qualifier, so leaving must clear them or the user keeps group-shared data access, direct
  // lake access and org-admin authority. Idempotent, so safe under a withTransaction retry.
  // Self-service, so the departing member is themselves the attributed principal - and the org's
  // own owner can never reach here, since leaving your own organization is refused above.
  const purged = await purgeOrgMembershipArtifacts(user.id, organization, { userId: user.id }, adapters);
  organization.adminUserIds = purged.adminUserIds;
  organization.managerId = purged.managerId;

  await adapters.db.organizations.update(organization);

  // If the org they just left was their currently-selected org, clear it. Otherwise org-scoped
  // access (data-lake AccessContext, team-wide prompts) would still be inferred from a stale
  // organizationId - the inverse of the join-side invariant set in acceptOrganization/addMember.
  //
  // The guard reads `user.organizationId`, which this function never mutates, so a withTransaction
  // retry (leave never re-fetches `user`) recomputes it identically and re-issues the same
  // idempotent set-to-null - the earlier version mutated `user` in memory here, which flipped the
  // guard false on a commit-time retry and silently skipped the write, leaving a stale org.
  //
  // Compare via toString(): `IUserDocument.organizationId` is TYPED as a string but production
  // hands us a hydrated Mongoose doc where it is an ObjectId (UserModel declares
  // Schema.Types.ObjectId with no stringifying transform), so a strict `===` against the route
  // param is ALWAYS false and the pointer never cleared. The type does not catch this; every other
  // reader of this field normalizes the same way (revokeAccess.ts, orgAccess.ts).
  if (user.organizationId?.toString() === id) {
    await adapters.db.users.update({ id: user.id, organizationId: null });
  }

  return organization;
};
