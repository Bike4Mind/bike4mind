import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { questRepository } from '@bike4mind/database';
import { AdminSupportAccessAction, IAdminSupportQuest, IAdminSupportQuestsResponse } from '@bike4mind/common';
import { authorizeSupportRead, recordSupportRead } from '@server/utils/adminSupportAccess';

/**
 * Read-only support view of a notebook's conversation - the user's prompts, the
 * model's replies, and the session fields derived from them (LLM summaries, the
 * entities the session remembered). This is the customer content the billing view
 * deliberately omits, so it carries the same gate as its sibling route: platform
 * admin only, `supportCase` required, and every page read is audited with the page
 * it returned.
 *
 * The conversation-derived session fields live here rather than on the session
 * route so that reading them is recorded as `session.quests.read` - a content
 * read - and not as a settings-and-attachments read.
 *
 * GET /api/admin/sessions/[id]/quests?supportCase=<ref>&page=1&limit=25
 */

const PaginationSchema = z.object({
  // `page` is capped as well as `limit`: an uncapped page number becomes an
  // arbitrarily large `.skip()`, which MongoDB walks row by row.
  page: z.coerce.number().int().positive().max(10_000).prefault(1),
  limit: z.coerce.number().int().positive().max(100).prefault(25),
  // Oldest-first by default: support reads a conversation forwards.
  sort: z.enum(['asc', 'desc']).prefault('asc'),
});

const handler = baseApi().get(async (req, res) => {
  const ctx = await authorizeSupportRead(req);
  const { page, limit, sort } = PaginationSchema.parse(req.query);

  const { data, hasMore } = await questRepository.findPageBySessionId(ctx.session.id, { page, limit, sort });

  // Awaited before responding: an unauditable support read is not served. The page
  // AND the conversation-derived fields actually disclosed are recorded, so the
  // trail is a faithful account of what was read rather than just that a read
  // happened.
  await recordSupportRead(ctx, AdminSupportAccessAction.SessionQuestsRead, {
    page,
    limit,
    sort,
    returned: data.length,
    hasMore,
    disclosedSummary: Boolean(ctx.session.summary),
    disclosedContextSummary: Boolean(ctx.session.contextSummary),
    disclosedConversationContext: Boolean(ctx.session.conversationContext),
  });

  const quests: IAdminSupportQuest[] = data.map(quest => ({
    id: quest.id,
    timestamp: quest.timestamp,
    type: quest.type,
    status: quest.status,
    errorCode: quest.errorCode,
    prompt: quest.prompt,
    reply: quest.reply,
    replies: quest.replies,
    fabFileIds: quest.fabFileIds,
    images: quest.images,
    model: quest.promptMeta?.model?.name,
    creditsUsed: quest.creditsUsed,
  }));

  const response: IAdminSupportQuestsResponse = {
    sessionId: ctx.session.id,
    page,
    limit,
    hasMore,
    quests,
    sessionContext: {
      summary: ctx.session.summary,
      contextSummary: ctx.session.contextSummary,
      conversationContext: ctx.session.conversationContext,
    },
  };
  return res.json(response);
});

export default handler;
