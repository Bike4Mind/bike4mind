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

  // `quest.images` holds bare generated-file basenames (e.g. `<uuid>.png`) served from the CDN
  // under `/generated`. Programmatic pollers shouldn't have to know that path convention, so we
  // derive ready-to-use URLs server-side - the single source of truth - mirroring the web client
  // (PromptReplies.tsx). `images` (raw basenames) is kept for parity with the WebSocket payload.
  // Skip URL building when no CDN is configured rather than emit a misleading relative path.
  const cdnUrl = process.env.NEXT_PUBLIC_CDN_URL || '';
  const images = quest.images ?? [];
  const imageUrls = cdnUrl ? images.map(name => `${cdnUrl}/generated/${name}`) : [];

  return res.json({
    id: quest.id,
    status: quest.status,
    sessionId: quest.sessionId,
    reply: quest.reply,
    replies: quest.replies,
    images,
    imageUrls,
    createdAt: quest.createdAt,
    updatedAt: quest.updatedAt,
    promptMeta: quest.promptMeta,
    executionTracking: quest.promptMeta?.executionTracking,
  });
});

export default handler;
