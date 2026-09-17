import { questRepository, sessionRepository } from '@bike4mind/database';
import { buildCorrectionPairs } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const sessionIdSchema = z.string().min(1);

/**
 * GET /api/sessions/[id]/correction-pairs
 *
 * The session's correction hops as eval triples (original answer, critique, corrected answer),
 * for exporting a user's own retries as evaluation data.
 *
 * `jwtOnly`: the payload is verbatim user prompts and model answers, so the api-key credential
 * chain is deliberately not installed - keeping this off the API-key surface is also what keeps
 * it out of OpenAPI and out of the api-contract requirement for public endpoints.
 *
 * Owner-only, stricter than the share check on sessions/[id]/chat/[messageId]: a read share
 * authorizes reading the conversation in the app, not exporting the owner's prose in bulk. A
 * non-owner and a session that does not exist both get the same 404, so the status cannot be
 * used to probe which session ids are real.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const parsedId = sessionIdSchema.safeParse(req.query.id);
    if (!parsedId.success) {
      return res.status(400).json({ error: 'Session id is required' });
    }
    const sessionId = parsedId.data;

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const session = await sessionRepository.findById(sessionId);
    // Positive ownership: userId is a non-empty string by the guard above, so this matches only
    // when the session records that same owner - an ownerless row cannot pass it.
    if (!session || session.userId !== userId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const pairs = await buildCorrectionPairs(sessionId, {
      findCorrectionLinks: id => questRepository.findCorrectionLinksBySessionId(id),
      findById: async questId => {
        const quest = await questRepository.findById(questId);
        if (!quest || quest.deletedAt) return null;
        // Projected field by field rather than spread: the walk needs prose and identity only, so
        // promptMeta, toolResults and attachments never enter the export path at all.
        return {
          id: quest.id ?? questId,
          sessionId: quest.sessionId,
          correctsQuestId: quest.correctsQuestId,
          prompt: quest.prompt,
          reply: quest.reply,
          replies: quest.replies,
          structuredReplies: quest.structuredReplies,
          timestamp: quest.timestamp,
        };
      },
    });

    // A session with no corrections is an empty export, not a missing one.
    return res.json({ pairs });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
