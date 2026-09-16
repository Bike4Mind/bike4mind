import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { HelpEventModel } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { HELP_FEEDBACK_RATINGS } from '@bike4mind/common';
import { routeHelpCommentToFeedback } from '@server/utils/helpFeedbackRouting';
import { z } from 'zod';

const HelpFeedbackSchema = z.object({
  slug: z.string().min(1).max(500),
  rating: z.enum(HELP_FEEDBACK_RATINGS).optional(),
  reportType: z.enum(['outdated']).optional(),
  comment: z.string().max(1000).optional(),
});

const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 100 : 30,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestError('User not authenticated');
    }

    const parsed = HelpFeedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid request: ${parsed.error.issues.map(i => i.message).join(', ')}`);
    }

    const { slug, rating, reportType, comment } = parsed.data;

    // The behavior half (which article, thumbs, the outdated report) stays here; the comment is
    // human-written and routes to Feedback below. Both stores carry the same 90-day TTL.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const updateFields: Partial<Pick<typeof parsed.data, 'rating' | 'reportType'>> = {};
    if (rating) updateFields.rating = rating;
    if (reportType) updateFields.reportType = reportType;

    // Dedup: revise a recent feedback entry from the same user+slug within the last 10 minutes
    // instead of creating a duplicate. A comment-only submission has nothing to $set but still
    // has to find that entry, or its comment would be stranded on a second, ratingless event -
    // and an empty $set is a MongoDB error, so that case reads without writing.
    const recentQuery = {
      type: 'article_feedback' as const,
      userId,
      slug,
      createdAt: { $gte: tenMinutesAgo },
    };
    const revised =
      Object.keys(updateFields).length > 0
        ? await HelpEventModel.findOneAndUpdate(
            recentQuery,
            { $set: updateFields },
            { sort: { createdAt: -1 }, new: true }
          )
        : await HelpEventModel.findOne(recentQuery).sort({ createdAt: -1 });

    const event =
      revised ??
      (await HelpEventModel.create({
        type: 'article_feedback',
        userId,
        slug,
        rating,
        reportType,
      }));

    if (comment) {
      await routeHelpCommentToFeedback({
        submitter: { id: userId, username: req.user?.username, email: req.user?.email },
        comment,
        helpContext: { eventId: event.id, surface: 'article', slug, rating: event.rating },
        logger: req.logger,
      });
    }

    res.status(revised ? 200 : 201).json({ success: true });
  });

export default handler;
