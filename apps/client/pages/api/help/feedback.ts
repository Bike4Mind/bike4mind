import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { HelpEventModel } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';

const HelpFeedbackSchema = z.object({
  slug: z.string().min(1).max(500),
  rating: z.enum(['helpful', 'not_helpful']).optional(),
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

    // Dedup: update a recent feedback entry from the same user+slug within the last
    // 10 minutes instead of creating a duplicate, so users can revise their rating/comment.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const updateFields: Partial<Pick<typeof parsed.data, 'rating' | 'comment' | 'reportType'>> = {};
    if (rating) updateFields.rating = rating;
    if (comment) updateFields.comment = comment;
    if (reportType) updateFields.reportType = reportType;

    if (Object.keys(updateFields).length > 0) {
      const updated = await HelpEventModel.findOneAndUpdate(
        {
          type: 'article_feedback',
          userId,
          slug,
          createdAt: { $gte: tenMinutesAgo },
        },
        { $set: updateFields },
        { sort: { createdAt: -1 }, new: true }
      );
      if (updated) {
        return res.status(200).json({ success: true });
      }
    }

    // No recent entry to update - create a new event
    await HelpEventModel.create({
      type: 'article_feedback',
      userId,
      slug,
      rating,
      reportType,
      comment,
    });

    res.status(201).json({ success: true });
  });

export default handler;
