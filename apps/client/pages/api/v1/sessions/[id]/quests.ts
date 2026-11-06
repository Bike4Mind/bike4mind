import { questRepository, sessionRepository } from '@bike4mind/database';
import { listSessionQuestsContract, questReplyText, type SessionQuest } from '@bike4mind/common';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';

const CURSOR_SCOPE = 'v1.session-quests';

/** Allowlist onto the public shape, so a new quest field stays private until it is added here and to the schema. */
function toPublicQuest(quest: IChatHistoryItemDocument, { isOwner }: { isOwner: boolean }): SessionQuest {
  return {
    id: quest.id,
    prompt: quest.prompt ?? null,
    reply: questReplyText(quest),
    status: quest.status,
    type: quest.type,
    // Gated on `type`, like GET /api/v1/quests/{id}: rows predating the retry fix can carry a stale code.
    ...(quest.type === 'error' && quest.errorCode && { errorCode: quest.errorCode }),
    createdAt: quest.timestamp ?? quest.createdAt,
    creditsUsed: quest.creditsUsed,
    // The pending approval is the owner's to act on and its params are the owner's tool input.
    pendingAction: isOwner ? quest.pendingAction : undefined,
  };
}

const handler = nextRouteForContract(listSessionQuestsContract, {
  // Reading history is not a metered action; only the per-minute burst limit applies.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { id: sessionId } = req.validatedParams;
  const { limit, cursor } = req.validatedQuery;

  // Same read gate as GET /api/sessions/{id}/chat: the owner, or a user/group the session is shared with.
  // A malformed id answers null, so it is the same 404 as an unknown or foreign one.
  const session = await sessionRepository.shareable.findAccessibleById(req.user, sessionId);
  if (!session) throw new NotFoundError('Session not found');

  const after = cursor === undefined ? undefined : decodeTimeIdCursor(cursor, CURSOR_SCOPE);
  // One extra row tells whether another page exists without a count query.
  const rows = await questRepository.findPageAfterBySessionId(session.id, {
    limit: limit + 1,
    after: after && { timestamp: after.at, id: after.id },
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit
      ? encodeTimeIdCursor(CURSOR_SCOPE, { at: last.timestamp ?? last.createdAt, id: last.id })
      : null;

  const isOwner = session.userId === req.user.id;
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ data: page.map(quest => toPublicQuest(quest, { isOwner })), next_cursor: nextCursor });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
