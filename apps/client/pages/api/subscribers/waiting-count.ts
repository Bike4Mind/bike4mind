import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError } from '@server/utils/errors';
import { subscriberRepository } from '@bike4mind/database';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    // "Waiting" = subscribers who haven't had invites generated yet
    const count = await subscriberRepository.countWaiting();

    return res.json({ count });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
