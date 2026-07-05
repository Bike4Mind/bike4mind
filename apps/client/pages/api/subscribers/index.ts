import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { subscriberRepository } from '@bike4mind/database/auth';

interface QueryParams {
  page?: string;
  limit?: string;
  search?: string;
}

const handler = baseApi().get(
  asyncHandler<unknown, unknown, unknown, QueryParams>(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

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
