import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { HelpEventModel } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';

const ChatFeedbackSchema = z.object({
  chatQuestion: z.string().min(1).max(2000),
  chatAnswer: z.string().min(1).max(10000),
  rating: z.enum(['helpful', 'not_helpful']),
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

    const parsed = ChatFeedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid request: ${parsed.error.issues.map(i => i.message).join(', ')}`);
    }

    const { chatQuestion, chatAnswer, rating, comment } = parsed.data;

    // Always try to dedup: update a recent chat feedback entry from the same
    // user+question+answer within the last 10 minutes. Rating is NOT in the match
    // filter so users can change their rating without creating duplicates.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const updateFields: Partial<Pick<typeof parsed.data, 'rating' | 'comment'>> = { rating };
    if (comment) updateFields.comment = comment;

    const updated = await HelpEventModel.findOneAndUpdate(
      {
        type: 'chat_feedback',
        userId,
        chatQuestion,
        chatAnswer,
        createdAt: { $gte: tenMinutesAgo },
      },
      { $set: updateFields },
      { sort: { createdAt: -1 }, new: true }
    );
    if (updated) {
      return res.status(200).json({ success: true });
    }

    // No recent entry to update; create a new event
    await HelpEventModel.create({
      type: 'chat_feedback',
      userId,
      chatQuestion,
      chatAnswer,
      rating,
      comment,
    });

    res.status(201).json({ success: true });
  });

export default handler;
