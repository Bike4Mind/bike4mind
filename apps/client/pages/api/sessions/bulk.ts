import { SessionEvents } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { sessionService } from '@bike4mind/services';
import { sessionRepository } from '@bike4mind/database/auth';
import { projectRepository, fabFileRepository } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';

const handler = baseApi()
  /**
   * Bulk delete sessions
   */
  .delete(
    asyncHandler<{}, { deletedCount: number; newLastNotebookId: string | null }, { sessionIds: string[] }>(
      async (req, res) => {
        const userId = req.user?.id;
        const { sessionIds } = req.body;

        if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
          return res.status(400).json({ deletedCount: 0, newLastNotebookId: null });
        }

        let newLastNotebook: { id: string } | null = null;
        let deletedCount = 0;

        // Delete sessions one by one to get proper newLastNotebook result
        for (const sessionId of sessionIds) {
          try {
            const result = await sessionService.deleteSession(
              userId,
              { id: sessionId },
              {
                db: {
                  sessions: sessionRepository,
                  projects: projectRepository,
                  fabFiles: fabFileRepository,
                },
              }
            );

            // Keep track of the last valid notebook suggestion
            if (result) {
              newLastNotebook = result;
            }
            deletedCount++;

            await logEvent(
              { userId, type: SessionEvents.DELETE_SESSION, metadata: { sessionId } },
              { ability: req.ability }
            );
          } catch (error) {
            console.error(`Failed to delete session ${sessionId}:`, error);
            // Continue with other sessions even if one fails
          }
        }

        return res.json({
          deletedCount,
          newLastNotebookId: newLastNotebook?.id || null,
        });
      }
    )
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
