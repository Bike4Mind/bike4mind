import { sessionRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';

/**
 * GET /api/notebooks/curate/[sessionId]
 *
 * Returns the curation status for a session
 */
const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    const { sessionId } = req.query as { sessionId: string };
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Session ID is required',
      });
    }

    try {
      const session = await sessionRepository.findById(sessionId);
      if (!session) {
        return res.status(404).json({
          success: false,
          message: 'Session not found',
        });
      }

      if (session.userId !== userId) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to access this session',
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          sessionId: session.id,
          isCurated: !!session.curatedNotebookFileId,
          curatedFileId: session.curatedNotebookFileId || null,
          curatedAt: session.curatedAt ? session.curatedAt.toISOString() : null,
        },
      });
    } catch (error) {
      req.logger.error('Failed to fetch curation status', { sessionId, userId, error });

      return res.status(500).json({
        success: false,
        message: 'Failed to fetch curation status',
      });
    }
  })
);

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
