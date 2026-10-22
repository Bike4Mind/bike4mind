import { ISessionDocument, SearchOptions, SessionListFilters, sessionSearchSchema } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

type SearchOwnSessionParameters = z.input<typeof sessionSearchSchema>;

interface SearchOwnSessionAdapters {
  db: {
    sessions: {
      searchByUserId: (
        search: string | undefined,
        userId: string,
        options: SearchOptions<ISessionDocument>,
        surface?: string,
        filters?: SessionListFilters
      ) => Promise<{ data: ISessionDocument[]; hasMore: boolean }>;
    };
  };
}

export const searchOwnSessions = async (
  userId: string,
  parameters: SearchOwnSessionParameters,
  { db }: SearchOwnSessionAdapters
) => {
  const { search, surface, pagination, orderBy, origin, excludeOrigin, hasImages } = secureParameters(
    parameters,
    sessionSearchSchema
  );

  const { page = 1, limit = 10 } = pagination || {};
  const { field = 'lastUpdated', direction = 'desc' } = orderBy || {};

  const filters: SessionListFilters = {
    ...(origin ? { origin } : {}),
    ...(excludeOrigin ? { excludeOrigin } : {}),
    ...(hasImages !== undefined ? { hasImages } : {}),
  };

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
    surface,
    // Omitted entirely when unset, so the default list call keeps its existing shape.
    ...(Object.keys(filters).length ? [filters] : [])
  );

  return result;
};
