import { Collection, CollectionType, IUserRepository, PaginatedResponse } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const searchUserCollectionSchema = z.object({
  userId: z.string(),
  page: z.coerce.number().prefault(1),
  limit: z.coerce.number().prefault(10),
  search: z.string().prefault(''),
  type: z.enum(CollectionType).optional(),
});

type SearchUserCollectionParameters = z.infer<typeof searchUserCollectionSchema>;

interface SearchUserCollectionAdapters {
  db: {
    users: Pick<IUserRepository, 'searchCollections'>;
    sessions: {
      findSessionIdsByUserId: (userId: string) => Promise<string[]>;
    };
  };
}

export async function searchUserCollection(
  parameters: SearchUserCollectionParameters,
  { db }: SearchUserCollectionAdapters
): Promise<PaginatedResponse<Collection>> {
  const { userId, page, limit, search, type } = secureParameters(parameters, searchUserCollectionSchema);

  return await db.users.searchCollections(
    userId,
    { page, limit, search, type },
    { findSessionIdsByUserId: db.sessions.findSessionIdsByUserId.bind(db.sessions) }
  );
}
