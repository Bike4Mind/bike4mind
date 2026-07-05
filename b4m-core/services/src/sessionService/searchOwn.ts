import { ISessionDocument, SearchOptions, searchSchema } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

type SearchOwnSessionParameters = z.infer<typeof searchSchema>;

interface SearchOwnSessionAdapters {
  db: {
    sessions: {
      searchByUserId: (
        search: string | undefined,
        userId: string,
        options: SearchOptions<ISessionDocument>,
        surface?: string
      ) => Promise<{ data: ISessionDocument[]; hasMore: boolean }>;
    };
  };
}

export const searchOwnSessions = async (
  userId: string,
  parameters: SearchOwnSessionParameters,
  { db }: SearchOwnSessionAdapters
) => {
  const { search, surface, pagination, orderBy } = secureParameters(parameters, searchSchema);

  const { page = 1, limit = 10 } = pagination || {};
  const { field = 'lastUpdated', direction = 'desc' } = orderBy || {};

  const result = await db.sessions.searchByUserId(
    search,
    userId,
    {
      pagination: {
        page,
        limit,
      },
      orderBy: {
        field: field as keyof ISessionDocument,
        direction,
      },
    },
    surface
  );

  return result;
};
