import { IOrganizationRepository, IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

/**
 * Schema for the search operation parameters
 */
export const searchSchema = z.object({
  /**
   * Text search query (searches in name and description)
   */
  query: z.string().optional(),
  /**
   * Filter by personal organizations
   */
  filters: z
    .object({
      personal: z.union([z.enum(['true', 'false']).transform(val => val === 'true'), z.boolean()]).optional(),
      userId: z.string().optional(),
    })
    .prefault({}),
  pagination: z
    .object({
      page: z.coerce.number().int().positive().prefault(1),
      limit: z.coerce.number().int().positive().max(100).prefault(10),
    })
    .prefault({
      page: 1,
      limit: 10,
    }),
  orderBy: z
    .object({
      field: z.enum(['name', 'createdAt', 'updatedAt']).prefault('name'),
      direction: z.enum(['asc', 'desc']).prefault('asc'),
    })
    .prefault({
      field: 'name',
      direction: 'asc',
    }),
});

export type SearchParameters = z.infer<typeof searchSchema>;

/**
 * Adapters interface for the search operation
 */
interface SearchAdapters {
  db: {
    organizations: IOrganizationRepository;
  };
}

/**
 * Search organizations with pagination and filtering
 *
 * @param user - The user making the request
 * @param params - The parameters for the operation
 * @param adapters - The adapters for the operation
 * @returns The list of organizations and pagination information
 */
export const search = async (user: IUserDocument, params: SearchParameters, adapters: SearchAdapters) => {
  const { query = '', filters, pagination, orderBy } = secureParameters(params, searchSchema);

  return adapters.db.organizations.search(query, filters, pagination, orderBy);
};
