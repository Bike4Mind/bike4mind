import { IProjectRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const searchProjectsSchema = z.object({
  search: z.string().optional(),
  filters: z
    .object({
      favorite: z.coerce.boolean().optional(),
      scope: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
  pagination: z
    .object({
      page: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
    })
    .optional(),
  orderBy: z
    .object({
      by: z.enum(['createdAt', 'updatedAt']).optional(),
      direction: z.enum(['asc', 'desc']).optional(),
    })
    .optional(),
});

type SearchProjectsParameters = z.infer<typeof searchProjectsSchema>;

interface SearchProjectsAdapters {
  db: {
    projects: IProjectRepository;
  };
}

export const searchProjects = async (
  userId: string,
  params: SearchProjectsParameters,
  adapters: SearchProjectsAdapters
) => {
  const { db } = adapters;
  const { search = '', filters = {}, pagination = {}, orderBy = {} } = secureParameters(params, searchProjectsSchema);
  const { page = 1, limit = 10 } = pagination;
  const { by = 'createdAt', direction = 'desc' } = orderBy;

  const projects = await db.projects.searchAccessible(
    userId,
    search,
    filters,
    {
      page,
      limit,
    },
    {
      by,
      direction,
    }
  );

  return projects;
};
