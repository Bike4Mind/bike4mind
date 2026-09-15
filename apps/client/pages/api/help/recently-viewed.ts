import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { HelpEventModel } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { buildRecentlyViewedPipeline, type RecentlyViewedArticle } from '@server/help/recentlyViewed';

/**
 * GET /api/help/recently-viewed
 *
 * Returns the authenticated user's most recently viewed help articles, derived from
 * the existing `article_view` HelpEvents, de-duplicated by slug and newest first.
 */
const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 500 : 100,
      windowMs: 60 * 1000,
    })
  )
  .get(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestError('User not authenticated');
    }

    const recentlyViewed = await HelpEventModel.aggregate<RecentlyViewedArticle>(buildRecentlyViewedPipeline(userId));

    res.json({ recentlyViewed });
  });

export default handler;
