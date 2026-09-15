import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { HelpEventModel } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';

const HelpEventSchema = z.object({
  type: z.enum(['article_view', 'search', 'chat_query']),
  slug: z.string().max(500).optional(),
  articleTitle: z.string().max(500).optional(),
  searchQuery: z.string().max(2000).optional(),
  searchResultCount: z.int().min(0).optional(),
  chatQuestion: z.string().max(2000).optional(),
});

const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 500 : 200,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestError('User not authenticated');
    }

    const parsed = HelpEventSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid request: ${parsed.error.issues.map(i => i.message).join(', ')}`);
    }

    const { type, slug, articleTitle, searchQuery, searchResultCount, chatQuestion } = parsed.data;

    // Deduplicate article views: skip if the same user viewed the same slug within 10 minutes
    if (type === 'article_view' && slug) {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const exists = await HelpEventModel.exists({
        type: 'article_view',
        userId,
        slug,
        createdAt: { $gte: tenMinutesAgo },
      });
      if (exists) {
        return res.status(204).end();
      }
    }

    await HelpEventModel.create({
      type,
      userId,
      slug,
      articleTitle,
      searchQuery,
      searchResultCount,
      chatQuestion,
    });

    res.status(204).end();
  });

export default handler;
