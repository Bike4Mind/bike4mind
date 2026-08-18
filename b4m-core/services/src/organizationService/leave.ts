import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { IGroupRepository, IOrganizationRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { purgeOrgMembershipArtifacts } from './purgeOrgMembership';

const organizationLeaveSchema = z.object({
  id: z.string(),
});

type OrganizationLeaveParameters = z.infer<typeof organizationLeaveSchema>;

interface OrganizationLeaveAdapters {
  db: {
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

  // Strip this org's group ids from the departing user and drop them from adminUserIds (the org
  // doc, persisted just below). `user.groups[]`/`adminUserIds` carry no org qualifier, so leaving
  // must clear them or the user keeps group-shared data access (the data-lake membership leak
  // class) and org-admin authority. Idempotent, so safe under a withTransaction retry.
  organization.adminUserIds = await purgeOrgMembershipArtifacts(user.id, organization, adapters);

  await adapters.db.organizations.update(organization);

  // If the org they just left was their currently-selected org, clear it. Otherwise org-scoped
  // access (data-lake AccessContext, team-wide prompts) would still be inferred from a stale
  // organizationId - the inverse of the join-side invariant set in acceptOrganization/addMember.
  //
  // The guard reads `user.organizationId`, which this function never mutates, so a withTransaction
  // retry (leave never re-fetches `user`) recomputes it identically and re-issues the same
  // idempotent set-to-null - the earlier version mutated `user` in memory here, which flipped the
  // guard false on a commit-time retry and silently skipped the write, leaving a stale org.
  if (user.organizationId === id) {
    await adapters.db.users.update({ id: user.id, organizationId: null });
  }

  return organization;
};
