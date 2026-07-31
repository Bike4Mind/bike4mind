import { IGroupRepository, IOrganizationRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { purgeOrgMembershipArtifacts } from './purgeOrgMembership';

const revokeAccessSchema = z.object({
  id: z.string(),
  userId: z.string(),
});

type RevokeAccessParameters = z.infer<typeof revokeAccessSchema>;

interface RevokeAccessAdapters {
  db: {
    organizations: IOrganizationRepository;
    groups: Pick<IGroupRepository, 'findByOrganization'>;
    users: Pick<IUserRepository, 'removeGroupsFromUser'>;
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

  // Only owner, manager, or admin can revoke access
  const isOwner = organization.userId === user.id;
  const isManager = organization.managerId === user.id;
  if (!isOwner && !isManager && !user.isAdmin) {
    throw new NotFoundError(`Organization not found for id: ${id}`); // Return same error to avoid info leakage
  }

  organization.users = organization.users.filter(user => user.userId.toString() !== userId);

  organization.userDetails ||= [];
  organization.userDetails = organization.userDetails.filter(user => user.id.toString() !== userId);

  // Mirror leave.ts: an involuntarily-removed member must not keep the org's group ids (data
  // access) or a seat in adminUserIds (org-admin authority - assertCanManageOrgGroups reads it).
  // Involuntary removal is exactly where retained access matters most. Idempotent under retry.
  organization.adminUserIds = await purgeOrgMembershipArtifacts(userId, organization, adapters);

  await adapters.db.organizations.update(organization);

  return organization;
};
