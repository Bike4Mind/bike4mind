// GET /api/users/:id/invites - Retrieves all pending invitations

import { baseApi } from '@server/middlewares/baseApi';
import { inviteRepository, cacheRepository } from '@bike4mind/database';
import { UnauthorizedError } from '@server/utils/errors';
import { sharingService, cacheService } from '@bike4mind/services';
import { z } from 'zod';
import { CacheKeys } from '@server/utils/cacheKeys';

const paginationSchema = z.object({
  limit: z.coerce.number().min(1).max(100).prefault(20),
  page: z.coerce.number().min(1).prefault(1),
});

const handler = baseApi().get(async (req, res) => {
  const currentUser = req.user;
  const id = req.query.id! as string;
  const { limit, page } = paginationSchema.parse(req.query);

  if (!((currentUser && currentUser?.id === id) || currentUser?.isAdmin)) throw new UnauthorizedError('Unauthorized');

  const cacheKey = CacheKeys.userInvites(id, limit, page);

  const result = await cacheService.getCachedData(
    cacheKey,
    async () =>
      await sharingService.listOwnPendingInvites(
        currentUser,
        { limit, page },
        {
          db: {
            invites: inviteRepository,
          },
        }
      ),
    {
      db: { caches: cacheRepository },
      expiry: 60 * 1000, // 1 minute
    }
  );

  return res.json({
    data: result.data,
    pagination: {
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
    },
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
