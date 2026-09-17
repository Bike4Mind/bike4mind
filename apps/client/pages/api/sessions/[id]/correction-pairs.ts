import { questRepository, sessionRepository } from '@bike4mind/database';
import { buildCorrectionPairs } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const sessionIdSchema = z.string().min(1);

/**
 * Bounds one export: the walk reads a prompt and an answer per corrected turn, and the jwtOnly
 * chain leaves out the api-key rate limiter (baseApi.ts). A session past the cap exports
 * its oldest corrections and says so, rather than returning a silently partial list.
 */
const MAX_EXPORTED_LINKS = 500;

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

    // Narrows `userId` to a non-empty string for the ownership compare below. The api layer
    // (baseApi's jwtOnly chain) is what actually rejects an anonymous caller.
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const session = await sessionRepository.findById(parsedId.data);
    // Positive ownership: userId is a non-empty string by the guard above, so this matches only
    // when the session records that same owner - an ownerless row cannot pass it.
    if (!session || session.userId !== userId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // The session's own id, not the raw query string: `findById` casts the id to an ObjectId, so it
    // can resolve a spelling that quests, which store `sessionId` as a string, never match literally.
    // Such an id would otherwise pass ownership and then find no corrections.
    const sessionId = session.id ?? parsedId.data;

    let truncated = false;
    const logger = { warn: (message: string) => req.logger?.warn?.(message) };
    const pairs = await buildCorrectionPairs(sessionId, {
      findCorrectionLinks: async id => {
        const links = await questRepository.findCorrectionLinksBySessionId(id, MAX_EXPORTED_LINKS + 1);
        truncated = links.length > MAX_EXPORTED_LINKS;
        return truncated ? links.slice(0, MAX_EXPORTED_LINKS) : links;
      },
      findById: async questId => {
        // Session-scoped, not a bare findById: containment is enforced at the query here as well
        // as per-hop in the walk, matching sessions/[id]/chat/[messageId]. Soft-deleted rows are
        // filtered by softDeletePlugin's findOne hook, so a deleted root reads as gone.
        const quest = await questRepository.findBySessionIdAndId(sessionId, questId);
        if (!quest) return null;
        // Projected field by field rather than spread: the walk needs prose and identity only, so
        // promptMeta, toolResults and images never enter the export path at all. Same field set as
        // findCorrectionLinksBySessionId's projection (QuestModel.ts) - the two must stay in sync.
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
      logger,
    });

    // A session with no corrections is an empty export, not a missing one.
    return res.json({ pairs, truncated });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
