import { IResearchTaskRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { IUserDocument } from '@bike4mind/common';

const searchResearchTasksSchema = z.object({
  search: z.string().optional(),
  // ADD FILTERS SCHEMA HERE
  // filters: z
  //   .object({
  //     userId: z.string().optional(),
  //   })
  //   .optional(),
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

type SearchResearchTasksParameters = z.infer<typeof searchResearchTasksSchema>;

interface SearchResearchTasksAdapters {
  db: {
    researchTasks: IResearchTaskRepository;
  };
}

export const search = async (
  user: IUserDocument,
  params: SearchResearchTasksParameters,
  adapters: SearchResearchTasksAdapters
) => {
  const { db } = adapters;
  const { search = '', pagination = {}, orderBy = {} } = secureParameters(params, searchResearchTasksSchema);
  const { page = 1, limit = 10 } = pagination;
  const { by = 'createdAt', direction = 'desc' } = orderBy;

  const researchTasks = await db.researchTasks.search(
    search,
    {
      userId: user.id,
    },
    {
      page,
      limit,
    },
    {
      by,
      direction,
    }
  );

  return researchTasks;
};
