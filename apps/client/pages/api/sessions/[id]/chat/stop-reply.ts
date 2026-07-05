import { stopReply } from '@server/managers/sessionManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';

const handler = baseApi().post(
  asyncHandler<{}, unknown, { urgent?: boolean }, { id?: string }>(async (req, res) => {
    const { id: sessionId } = req.query;
    if (!sessionId) {
      throw new NotFoundError('Session not found');
    }

    Logger.info(`Received cancellation request for session ${sessionId}`, {
      urgent: req.body.urgent,
      userId: req.user?.id,
    });

    const result = await stopReply(sessionId, req.ability!);

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
