import { IOrganizationDocument, IOrganizationRepository, IUserDocument, WithId } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

/**
 * Schema for the getOrganization operation parameters
 */
export const getSchema = z.object({
  /**
   * Organization ID
   */
  id: z.string().min(1),
});

export type GetParameters = z.infer<typeof getSchema>;

/**
 * Adapters interface for the getOrganization operation
 */
interface GetAdapters {
  db: {
    organizations: IOrganizationRepository;
  };
}

/**
 * Get a single organization by ID
 *
 * @param user - The user making the request
 * @param params - The parameters for the operation
 * @param adapters - The adapters for the operation
 * @returns The organization
 * @throws NotFoundError if the organization is not found
 */
export const get = async (
  user: IUserDocument,
  params: GetParameters,
  adapters: GetAdapters
): Promise<WithId<IOrganizationDocument>> => {
  const validatedParams = secureParameters(params, getSchema);
  const { id } = validatedParams;

  let organization = await adapters.db.organizations.shareable.findAccessibleById(user, id);

  // If the user is an admin, they can access all organizations
  if (!organization && user.isAdmin) {
    organization = await adapters.db.organizations.findById(id);
  }

  if (!organization) {
    throw new NotFoundError(`Organization with ID ${id} not found`);
  }

  return organization;
};
