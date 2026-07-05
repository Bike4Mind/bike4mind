import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { importHistoryJobRepository } from '@bike4mind/database';

const handler = baseApi({ auth: true }).get(
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { status, source, page = '1', limit = '10', orderBy = 'createdAt', direction = 'desc' } = req.query as any;

    const filters: any = { userId };
    if (status) filters.status = status;
    if (source) filters.source = source;

    const result = await importHistoryJobRepository.search(
      '', // No text search, just filtering
      filters,
      {
        page: parseInt(page),
        limit: parseInt(limit),
      },
      {
        by: orderBy,
        direction: direction,
      }
    );

    return res.json({
      success: true,
      data: result.data,
      hasMore: result.hasMore,
      total: result.total,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
