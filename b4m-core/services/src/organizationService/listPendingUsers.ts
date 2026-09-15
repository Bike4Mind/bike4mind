import { IInviteRepository, IOrganizationRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const listPendingUsersSchema = z.object({
  organizationId: z.string(),
});

type ListPendingUsersParameters = z.infer<typeof listPendingUsersSchema>;

interface ListPendingUsersAdapters {
  db: {
    invites: IInviteRepository;
    users: IUserRepository;
    organizations: IOrganizationRepository;
  };
}

/**
 * List pending users for an organization
 *
 * @param user - The user making the request
 * @param parameters - The parameters for the operation
 * @param adapters - The adapters for the operation
 * @returns The pending users for the organization
 */
export const listPendingUsers = async (
  user: IUserDocument,
  parameters: ListPendingUsersParameters,
  adapters: ListPendingUsersAdapters
) => {
  const { organizationId } = secureParameters(parameters, listPendingUsersSchema);
  let organization = await adapters.db.organizations.shareable.findAccessibleById(user, organizationId);
  if (!organization && user.isAdmin) {
    organization = await adapters.db.organizations.findById(organizationId);
  }
  if (!organization) {
    throw new NotFoundError('Organization not found');
  }

  const inviteDocs = await adapters.db.invites.findAllByDocumentId(organizationId);
  if (!inviteDocs) {
    return [];
  }

  const emailOrUsernames = inviteDocs.map(invite => invite.recipients?.pending || []).flat();

  const users = await adapters.db.users.findAllByEmailsOrUsernames(emailOrUsernames, emailOrUsernames);

  return users;
};
