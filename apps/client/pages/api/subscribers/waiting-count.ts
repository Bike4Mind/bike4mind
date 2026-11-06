import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { subscriberRepository } from '@bike4mind/database';

const handler = adminApi({ adminPermissions: { GET: 'credits:adjust' } }).get(
  asyncHandler(async (req, res) => {
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
