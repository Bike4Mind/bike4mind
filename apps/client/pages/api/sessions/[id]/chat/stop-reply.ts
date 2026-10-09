import { stopReply } from '@server/managers/sessionManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { isValidObjectId } from '@server/utils/objectId';
import { Logger } from '@bike4mind/observability';
import { dispatchQuestCallback } from '@server/generationCallback/dispatchQuestCallback';

const handler = baseApi().post(
  asyncHandler<{}, unknown, { urgent?: boolean; questId?: string }, { id?: string }>(async (req, res) => {
    const { id: sessionId } = req.query;
    if (!sessionId) {
      throw new NotFoundError('Session not found');
    }
    const { questId } = req.body;
    if (questId !== undefined && !isValidObjectId(questId)) {
      throw new BadRequestError('Invalid questId');
    }

    Logger.info(`Received cancellation request for session ${sessionId}`, {
      urgent: req.body.urgent,
      questId,
      userId: req.user?.id,
    });

    const result = await stopReply(sessionId, req.ability!, questId);
    // A stop settles the quest, so it is one of the completion-callback settle sites (see
    // dispatchQuestCallback); a no-op for a quest with no armed callback.
    if (result?.status === 'stopped') {
      await dispatchQuestCallback(result.id, req.logger);
    }

    return res.json({
      msg: 'Chat stopped',
      status: 'cancelled',
      questId: result?.id,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
