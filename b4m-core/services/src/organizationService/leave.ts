import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { IGroupRepository, IOrganizationRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

const organizationLeaveSchema = z.object({
  id: z.string(),
});

type OrganizationLeaveParameters = z.infer<typeof organizationLeaveSchema>;

interface OrganizationLeaveAdapters {
  db: {
    organizations: IOrganizationRepository;
    users: Pick<IUserRepository, 'update'>;
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

  await adapters.db.organizations.update(organization);

  // Purge every group id belonging to this org from the departing user. `user.groups[]` carries
  // no org qualifier, so leaving an org must strip its group ids or the user keeps access to
  // anything shared with that org's groups (the same class of bug as the data-lake membership
  // leak). Independent of the selected-org clear below: a user can be in an org's group without
  // that org being their currently-selected one.
  const orgGroups = await adapters.db.groups.findByOrganization(id);
  const orgGroupIds = new Set(orgGroups.map(group => group.id));
  const remainingGroups = (user.groups ?? []).filter(groupId => !orgGroupIds.has(groupId));
  const groupsChanged = remainingGroups.length !== (user.groups?.length ?? 0);

  // If the org they just left was their currently-selected org, clear it. Otherwise org-scoped
  // access (data-lake AccessContext, team-wide prompts) would still be inferred from a stale
  // organizationId - the inverse of the join-side invariant set in acceptOrganization/addMember.
  const shouldClearOrg = user.organizationId === id;

  // Persist the target values BEFORE mutating the caller-supplied `user` in memory.
  // `withTransaction` retries this callback on a transient error against the SAME `user` object
  // (leave never re-fetches it), and the purge is recomputed identically each attempt - so a
  // retry is idempotent. Mutating memory first would flip the guards below to a no-op on retry.
  if (shouldClearOrg || groupsChanged) {
    const patch: Partial<IUserDocument> = { id: user.id };
    if (shouldClearOrg) patch.organizationId = null;
    if (groupsChanged) patch.groups = remainingGroups;
    await adapters.db.users.update(patch);
    if (shouldClearOrg) user.organizationId = null;
    if (groupsChanged) user.groups = remainingGroups;
  }

  return organization;
};
