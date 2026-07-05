import { IOrganizationRepository, IUserDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const revokeAccessSchema = z.object({
  id: z.string(),
  userId: z.string(),
});

type RevokeAccessParameters = z.infer<typeof revokeAccessSchema>;

interface RevokeAccessAdapters {
  db: {
    organizations: IOrganizationRepository;
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

  await adapters.db.organizations.update(organization);

  return organization;
};
