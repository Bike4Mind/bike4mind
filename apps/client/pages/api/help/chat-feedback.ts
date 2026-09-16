import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { HelpEventModel } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { HELP_FEEDBACK_RATINGS } from '@bike4mind/common';
import { routeHelpCommentToFeedback, syncRoutedVerdict } from '@server/utils/helpFeedbackRouting';
import { z } from 'zod';

const ChatFeedbackSchema = z.object({
  chatQuestion: z.string().min(1).max(2000),
  chatAnswer: z.string().min(1).max(10000),
  rating: z.enum(HELP_FEEDBACK_RATINGS),
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

    // The behavior half (the question/answer pair and the thumbs) stays here; the comment is
    // human-written and routes to Feedback below. Both stores carry the same 90-day TTL.
    //
    // Always try to dedup: update a recent chat feedback entry from the same
    // user+question+answer within the last 10 minutes. Rating is NOT in the match
    // filter so users can change their rating without creating duplicates.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    const revised = await HelpEventModel.findOneAndUpdate(
      {
        type: 'chat_feedback',
        userId,
        chatQuestion,
        chatAnswer,
        createdAt: { $gte: tenMinutesAgo },
      },
      { $set: { rating } },
      { sort: { createdAt: -1 }, new: true }
    );

    const event =
      revised ??
      (await HelpEventModel.create({
        type: 'chat_feedback',
        userId,
        chatQuestion,
        chatAnswer,
        rating,
      }));

    if (comment) {
      // No slug: help chat has no article. The question and answer are free text and stay on the
      // TTL'd event that `eventId` points at rather than being copied onto the permanent report.
      await routeHelpCommentToFeedback({
        submitter: { id: userId, username: req.user?.username, email: req.user?.email },
        comment,
        helpContext: { eventId: event.id, surface: 'chat', rating },
        logger: req.logger,
      });
    } else if (rating) {
      // Same two-site verdict as the article route - see syncRoutedVerdict. No reportType: help
      // chat has no article to flag as outdated.
      await syncRoutedVerdict({ eventId: event.id, userId, rating });
    }

    res.status(revised ? 200 : 201).json({ success: true });
  });

export default handler;
