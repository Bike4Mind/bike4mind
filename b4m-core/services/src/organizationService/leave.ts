import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { IOrganizationRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

const organizationLeaveSchema = z.object({
  id: z.string(),
});

type OrganizationLeaveParameters = z.infer<typeof organizationLeaveSchema>;

interface OrganizationLeaveAdapters {
  db: {
    organizations: IOrganizationRepository;
    users: Pick<IUserRepository, 'update'>;
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

  await adapters.db.organizations.update(organization);

  // If the org they just left was their currently-selected org, clear it. Otherwise
  // org-scoped access (data-lake AccessContext, team-wide prompts) would still be
  // inferred from a stale organizationId - the inverse of the join-side invariant
  // set in acceptOrganization/addMember.
  //
  // Persist the target value BEFORE mutating the caller-supplied `user` in memory.
  // `withTransaction` retries this callback on a transient error against the SAME
  // `user` object (leave never re-fetches it, unlike addMember/acceptInvite). If we
  // mutated memory first, the retry's `user.organizationId === id` guard would be
  // false and the user write would be silently skipped, leaving a stale selected org.
  if (user.organizationId === id) {
    await adapters.db.users.update({ ...user, organizationId: null } as IUserDocument);
    user.organizationId = null;
  }

  return organization;
};
