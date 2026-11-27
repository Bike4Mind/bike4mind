import {
  ISessionDocument,
  MAX_SESSION_LIST_LIMIT,
  SearchOptions,
  SessionListFilters,
  SessionListPage,
  SessionListPageOptions,
  sessionSearchSchema,
} from '@bike4mind/common';
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
        filters?: SessionListFilters,
        page?: SessionListPageOptions
      ) => Promise<SessionListPage>;
    };
  };
}

export const searchOwnSessions = async (
  userId: string,
  parameters: SearchOwnSessionParameters,
  { db }: SearchOwnSessionAdapters,
  page: SessionListPageOptions = {}
) => {
  const { search, surface, pagination, orderBy, origin, excludeOrigin, hasImages } = secureParameters(
    parameters,
    sessionSearchSchema
  );

  const { page: pageNumber = 1, limit: requestedLimit = 10 } = pagination || {};
  // Clamped rather than rejected so an older client asking for more still gets a page (with hasMore).
  const limit = Math.min(requestedLimit, MAX_SESSION_LIST_LIMIT);
  const { field = 'lastUpdated', direction = 'desc' } = orderBy || {};

  const filters: SessionListFilters = {
    ...(origin ? { origin } : {}),
    ...(excludeOrigin ? { excludeOrigin } : {}),
    ...(hasImages !== undefined ? { hasImages } : {}),
  };

  return db.sessions.searchByUserId(
    search,
    userId,
    {
      pagination: {
        page: pageNumber,
        limit,
      },
      orderBy: {
        field: field as keyof ISessionDocument,
        direction,
      },
    },
    surface,
    filters,
    page
  );
};
