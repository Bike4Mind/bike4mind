import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { HelpEventModel } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { stitchRoutedComments } from '@server/utils/helpFeedbackRouting';

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

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    const [articleEvents, chatEvents] = await Promise.all([
      HelpEventModel.find({
        type: 'article_feedback',
        userId,
        createdAt: { $gte: tenMinutesAgo },
      })
        .sort({ createdAt: -1 })
        // `comment` is no longer written here, but rows from before the split still carry one and
        // are read back as a fallback (see stitchRoutedComments) until they age out under the TTL.
        .select('slug rating reportType comment createdAt')
        .lean(),

      HelpEventModel.find({
        type: 'chat_feedback',
        userId,
        createdAt: { $gte: tenMinutesAgo },
      })
        .sort({ createdAt: -1 })
        .select('chatQuestion chatAnswer rating comment createdAt')
        .lean(),
    ]);

    // Re-populates the feedback UI on re-navigation, so both stores have to be read back as one:
    // the behavior half lives on HelpEvent, the comment on the Feedback report routed from it.
    const [articleFeedback, chatFeedback] = await stitchRoutedComments([articleEvents, chatEvents], { userId });

    // Field-for-field the shape the clients already consume - `HelpChat.tsx` matches a chat entry
    // by exact (chatQuestion, chatAnswer) equality, so these must survive verbatim.
    res.json({ articleFeedback, chatFeedback });
  });

export default handler;
