import { Permission, IUserDocument, IOrganizationRepository, IUserRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { NotFoundError, UnprocessableEntityError } from '@bike4mind/utils';
import { z } from 'zod';

const addMemberSchema = z.object({
  userId: z.string().optional(),
  email: z.string().optional(),
  organizationId: z.string(),
  force: z.boolean().optional(), // If true, add the user to the organization even if it's at full capacity
});

type AddMemberParameters = z.infer<typeof addMemberSchema>;

interface AddMemberAdapters {
  db: {
    users: IUserRepository;
    organizations: IOrganizationRepository;
  };
  logger?: {
    info: (message: string) => void;
  };
}

/**
 * Adds a user to an organization, returning the updated organization and user.
 */
export async function addMember(user: IUserDocument, parameters: AddMemberParameters, adapters: AddMemberAdapters) {
  const { db, logger } = adapters;
  const { userId, email, organizationId, force } = secureParameters(parameters, addMemberSchema);

  const userToAdd = userId ? await db.users.findById(userId) : email ? await db.users.findByEmail(email) : null;
  if (!userToAdd) throw new NotFoundError('User not found');

  let organization = await db.organizations.shareable.findAccessibleById(user, organizationId);
  if (!organization && user.isAdmin) {
    logger?.info(`User ${user.id} is an admin, accessing organization ${organizationId}`);

    organization = await db.organizations.findById(organizationId);
  }

  if (!organization) throw new NotFoundError('Organization not found');

  if (!force && organization.users.length >= organization.seats) {
    throw new UnprocessableEntityError('Organization is at full capacity');
  }

  // Add the user to the organization's users array
  const userIndex = organization.users.findIndex(f => f.userId === userToAdd.id);

  if (userIndex >= 0) {
    // Already a member - just refresh their permissions
    organization.users[userIndex].permissions = [Permission.read];
  } else {
    organization.users.push({ userId: userToAdd.id, permissions: [Permission.read] });
  }

  await db.organizations.update(organization);

  // Establish org membership on the user document. Org-scoped features (e.g.
  // data-lake AccessContext) read user.organizationId; without this, members
  // added via this path stay organizationId: null and get no org-scoped access -
  // the same defect fixed for invite acceptance in sharingService/accept.ts.
  userToAdd.organizationId = organizationId;
  await db.users.update(userToAdd);

  return { organization, user: userToAdd };
}
