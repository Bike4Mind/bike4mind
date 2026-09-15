import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { HelpEventModel } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';

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

    const [articleFeedback, chatFeedback] = await Promise.all([
      HelpEventModel.find({
        type: 'article_feedback',
        userId,
        createdAt: { $gte: tenMinutesAgo },
      })
        .sort({ createdAt: -1 })
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

    res.json({ articleFeedback, chatFeedback });
  });

export default handler;
