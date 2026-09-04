import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { HelpEventModel } from '@bike4mind/database';
import { BadRequestError, ForbiddenError } from '@bike4mind/utils';

function parseDate(value: string, label: string): Date {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new BadRequestError(`Invalid ${label} date format`);
  }
  return d;
}

// Parses a date-only string and shifts it into the caller's local day (to the end of that day
// when `endOfDay`). parseDate validates the parse; the assert below validates the SHIFT, which
// is a separate failure mode: a date at either edge of the JS Date range parses cleanly and
// still overflows once the offset or end-of-day shift lands, even for an in-range offset. An
// Invalid Date would cast against the Date-typed `createdAt` and answer 500 rather than 400.
// Same reasoning as admin/email/whats-new-content.ts: assert the constructed date, not its input.
function shiftedDate(value: string, label: string, offsetMinutes: number, endOfDay: boolean): Date {
  const d = parseDate(value, label);
  d.setUTCMinutes(d.getUTCMinutes() + offsetMinutes);
  if (endOfDay) {
    d.setUTCHours(d.getUTCHours() + 23, d.getUTCMinutes() + 59, 59, 999);
  }
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestError(`Invalid ${label} date format`);
  }
  return d;
}

const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 100 : 20,
      windowMs: 60 * 1000,
    })
  )
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const { dateFrom, dateTo, tzOffset } = req.query;

    // Parse the user's timezone offset (minutes from UTC, e.g. PST = 480).
    // Used to shift date-only strings so "Feb 20" for a PST user means
    // local midnight in UTC (e.g. T08:00:00Z for PST) instead of UTC midnight.
    const offsetMinutes = typeof tzOffset === 'string' ? parseInt(tzOffset, 10) : 0;
    // Clamped to the real UTC offset range (+/-14h) so an absurd offset cannot shift a sane
    // date out of range. This bounds the offset only; shiftedDate rejects the overflow itself.
    const validOffset = Number.isFinite(offsetMinutes) ? Math.min(Math.max(offsetMinutes, -840), 840) : 0;

    const createdAtFilter: { $gte?: Date; $lte?: Date } = {};
    if (typeof dateFrom === 'string') {
      createdAtFilter.$gte = shiftedDate(dateFrom, 'dateFrom', validOffset, false);
    }
    if (typeof dateTo === 'string') {
      createdAtFilter.$lte = shiftedDate(dateTo, 'dateTo', validOffset, true);
    }
    const dateFilter = Object.keys(createdAtFilter).length ? { createdAt: createdAtFilter } : {};

    const [topArticles, searchGaps, feedbackSummary, chatTopics, overview, recentFeedback, chatFeedback] =
      await Promise.all([
        // Top 20 most-viewed articles
        HelpEventModel.aggregate([
          { $match: { type: 'article_view', ...dateFilter } },
          {
            $group: {
              _id: '$slug',
              articleTitle: { $last: '$articleTitle' },
              viewCount: { $sum: 1 },
            },
          },
          { $sort: { viewCount: -1 } },
          { $limit: 20 },
          {
            $project: {
              _id: 0,
              slug: '$_id',
              title: '$articleTitle',
              viewCount: 1,
            },
          },
        ]),

        // Search queries with 0 results, grouped and counted
        HelpEventModel.aggregate([
          { $match: { type: 'search', searchResultCount: 0, ...dateFilter } },
          {
            $group: {
              _id: { $toLower: '$searchQuery' },
              count: { $sum: 1 },
              lastSearched: { $max: '$createdAt' },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 50 },
          {
            $project: {
              _id: 0,
              query: '$_id',
              count: 1,
              lastSearched: 1,
            },
          },
        ]),

        // Per-article feedback counts
        HelpEventModel.aggregate([
          { $match: { type: 'article_feedback', ...dateFilter } },
          {
            $group: {
              _id: '$slug',
              helpful: { $sum: { $cond: [{ $eq: ['$rating', 'helpful'] }, 1, 0] } },
              notHelpful: { $sum: { $cond: [{ $eq: ['$rating', 'not_helpful'] }, 1, 0] } },
              outdated: { $sum: { $cond: [{ $eq: ['$reportType', 'outdated'] }, 1, 0] } },
              totalFeedback: { $sum: 1 },
            },
          },
          { $sort: { totalFeedback: -1 } },
          { $limit: 50 },
          {
            $project: {
              _id: 0,
              slug: '$_id',
              helpful: 1,
              notHelpful: 1,
              outdated: 1,
              totalFeedback: 1,
            },
          },
        ]),

        // Chat topics grouped by frequency
        HelpEventModel.aggregate([
          { $match: { type: 'chat_query', ...dateFilter } },
          {
            $group: {
              _id: { $toLower: '$chatQuestion' },
              count: { $sum: 1 },
              lastAsked: { $max: '$createdAt' },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 50 },
          {
            $project: {
              _id: 0,
              question: '$_id',
              count: 1,
              lastAsked: 1,
            },
          },
        ]),

        // Overview counts
        Promise.all([
          HelpEventModel.countDocuments({ type: 'article_view', ...dateFilter }),
          HelpEventModel.countDocuments({ type: 'search', ...dateFilter }),
          HelpEventModel.countDocuments({ type: 'article_feedback', ...dateFilter }),
          HelpEventModel.countDocuments({ type: 'chat_query', ...dateFilter }),
          HelpEventModel.distinct('slug', { type: 'article_view', ...dateFilter }),
          HelpEventModel.countDocuments({ type: 'chat_feedback', ...dateFilter }),
        ]).then(([totalViews, totalSearches, totalFeedback, totalChatQueries, uniqueSlugs, totalChatFeedback]) => ({
          totalViews,
          totalSearches,
          totalFeedback,
          totalChatQueries,
          uniqueArticlesViewed: uniqueSlugs.length,
          totalChatFeedback,
        })),

        // Recent feedback with comments
        HelpEventModel.find({ type: 'article_feedback', ...dateFilter })
          .sort({ createdAt: -1 })
          .limit(50)
          .select('slug rating reportType comment userId createdAt')
          .lean(),

        // Chat feedback (thumbs up/down on AI responses)
        HelpEventModel.find({ type: 'chat_feedback', ...dateFilter })
          .sort({ createdAt: -1 })
          .limit(50)
          .select('chatQuestion chatAnswer rating comment userId createdAt')
          .lean(),
      ]);

    res.json({
      topArticles,
      searchGaps,
      feedbackSummary,
      chatTopics,
      overview,
      recentFeedback,
      chatFeedback,
    });
  });

export default handler;
