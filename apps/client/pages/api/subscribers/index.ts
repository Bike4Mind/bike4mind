import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { subscriberRepository } from '@bike4mind/database/auth';

interface QueryParams {
  page?: string;
  limit?: string;
  search?: string;
}

const handler = adminApi({ adminPermissions: { GET: 'credits:adjust' } }).get(
  asyncHandler<unknown, unknown, unknown, QueryParams>(async (req, res) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const search = req.query.search;

    const subscribers = await subscriberRepository.listSubscribers({
      page,
      limit,
      search,
    });

    return res.json(subscribers);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
