import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sessionRepository, sessionAgentConfigRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError, UnauthorizedError } from '@bike4mind/utils';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const { id: sessionId } = req.query;

    if (typeof sessionId !== 'string') {
      throw new BadRequestError('Invalid session ID');
    }

    // Verify session exists and user has access
    const session = await sessionRepository.findById(sessionId);
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.userId !== req.user!.id) {
      throw new UnauthorizedError('Unauthorized');
    }

    const configs = await sessionAgentConfigRepository.findBySessionId(sessionId);

    res.json({ configs });
  })
);

export default handler;
