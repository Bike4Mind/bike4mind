import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { questRepository, sessionRepository } from '@bike4mind/database';
import type { Request } from 'express';

const handler = baseApi().post(async (req: Request<{}, {}, {}, { id: string }>, res) => {
  const { id: questId } = req.query;
  const userId = req.user?.id;

  if (!questId) {
    throw new BadRequestError('Quest ID is required');
  }

  const quest = await questRepository.findById(questId);
  if (!quest) {
    throw new NotFoundError('Quest not found');
  }

  // Validate user access via session ownership
  const session = await sessionRepository.findById(quest.sessionId);
  if (!session) {
    throw new NotFoundError('Quest not found');
  }

  const userHasAccess = session.userId === userId || session.users?.some(userShare => userShare.userId === userId);
  if (!userHasAccess) {
    throw new NotFoundError('Quest not found');
  }

  // Check if the quest is truly stuck: running status, old enough, and no reply content.
  // Threshold is 120s (2x the client-side trigger of 90s). The server-side streaming heartbeat
  // touches updatedAt every ~10s, so any actively-streaming quest will look fresh well before this.
  const TIMEOUT_THRESHOLD_MS = 120_000;
  const questAge = Date.now() - new Date(quest.updatedAt).getTime();
  const isStuck =
    quest.status === 'running' &&
    questAge > TIMEOUT_THRESHOLD_MS &&
    !quest.reply &&
    (!quest.replies || quest.replies.length === 0 || quest.replies.every(r => !r));

  if (!isStuck) {
    return res.json(quest);
  }

  // Mark the quest as a timeout error
  const updatedQuest = await questRepository.update({
    id: quest.id,
    status: 'done',
    type: 'error',
    reply: 'This request timed out. The server did not respond in time. Please try again.',
  });

  return res.json(updatedQuest);
});

export default handler;
