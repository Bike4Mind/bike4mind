import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { questRepository, sessionRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import type { Request } from 'express';

// Reading a quest is the documented poll step after POST /api/chat, so an AI
// scope (ai:chat / ai:generate) grants it as well as notebooks:read - otherwise
// a least-privilege chat key 403s on its own reply. OR / "any of" semantics.
const handler = baseApi({
  requiredScopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
}).get(async (req: Request<{}, {}, {}, { id: string }>, res) => {
  const { id: questId } = req.query;
  const userId = req.user?.id;

  if (!questId) {
    throw new BadRequestError('Quest ID is required');
  }

  const quest = await questRepository.findById(questId);

  if (!quest) {
    throw new NotFoundError('Quest not found');
  }

  const session = await sessionRepository.findById(quest.sessionId);
  if (!session) {
    throw new NotFoundError('Quest not found');
  }

  const userHasAccess = session.userId === userId || session.users?.some(userShare => userShare.userId === userId);

  if (!userHasAccess) {
    throw new NotFoundError('Quest not found');
  }

  return res.json({
    id: quest.id,
    status: quest.status,
    sessionId: quest.sessionId,
    reply: quest.reply,
    replies: quest.replies,
    createdAt: quest.createdAt,
    updatedAt: quest.updatedAt,
    promptMeta: quest.promptMeta,
    executionTracking: quest.promptMeta?.executionTracking,
  });
});

export default handler;
