import { CollectionType } from '@bike4mind/common';
import { userRepository, sessionRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const PaginatedCollectionsQuerySchema = z.object({
  id: z.string(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  search: z.string().optional().prefault(''),
  type: z.enum(CollectionType).nullable().optional(),
});

/**
 * Fetches a paginated list of collections for a user.
 * /api/users/:id/collections
 */
const handler = baseApi().get(async (req, res) => {
  const { id, page = 1, limit = 10, search, type } = PaginatedCollectionsQuerySchema.parse(req.query);

  const result = await userService.searchUserCollection(
    { userId: id, page, limit, search, type: type ?? undefined },
    {
      db: {
        users: userRepository,
        sessions: sessionRepository,
      },
    }
  );

  return res.json(result);
});

export default handler;
