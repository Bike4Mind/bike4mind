import { IOrganizationRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { get } from './get';

const getUsersSchema = z.object({
  id: z.string(),
});

type GetUsersParameters = z.infer<typeof getUsersSchema>;

interface GetUsersAdapters {
  db: {
    organizations: IOrganizationRepository;
    users: IUserRepository;
  };
}

/**
 * Get the users of an organization together with the organization they were read from, so the
 * caller can scope the roster to the viewer's role (`organizationRosterScope` in @bike4mind/common).
 *
 * @param user - The user making the request
 * @param parameters - The parameters for the operation
 * @param adapters - The adapters for the operation
 */
export const getRoster = async (user: IUserDocument, parameters: GetUsersParameters, adapters: GetUsersAdapters) => {
  const { id } = secureParameters(parameters, getUsersSchema);

  const organization = await get(user, { id }, adapters);

  const userIds = organization.users.map(user => user.userId);
  userIds.push(organization.userId);
  const users = await adapters.db.users.findByIds(userIds);

  return { organization, users };
};

/**
 * Get the users of an organization
 *
 * @param user - The user making the request
 * @param parameters - The parameters for the operation
 * @param adapters - The adapters for the operation
 * @returns The users of the organization
 */
const getUsers = async (user: IUserDocument, parameters: GetUsersParameters, adapters: GetUsersAdapters) =>
  (await getRoster(user, parameters, adapters)).users;

export default getUsers;
