import { CollectionType } from '@bike4mind/common';
import { userRepository, sessionRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
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

  // A user's collections are private to them; only the user themselves or an
  // admin may list them.
  if (id !== req.user.id && !req.user.isAdmin) {
    throw new ForbiddenError('Not authorized to view this user\'s collections');
  }

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
