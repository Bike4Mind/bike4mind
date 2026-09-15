import { NotebookCurationEvents } from '@server/utils/eventBus';
import { sessionRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { NotebookCurateRequestSchema } from '../../../types/api';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    let validatedBody: z.infer<typeof NotebookCurateRequestSchema>;
    try {
      validatedBody = NotebookCurateRequestSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          message: 'Invalid request body',
          errors: error.issues.map(err => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      throw error;
    }

    const { sessionIds, curationType, artifactTypes, exportFormat, customNotebookName } = validatedBody;

    try {
      const batchJobId = uuidv4();
      const batchTotal = sessionIds.length;

      req.logger.info('Triggering batch notebook curation', {
        sessionIds,
        userId,
        batchJobId,
        batchTotal,
        curationType: curationType || 'transcript',
        artifactTypes: artifactTypes || 'all',
        exportFormat: exportFormat || 'markdown',
      });

      // Verify all sessions exist and belong to user
      const sessions = await Promise.all(sessionIds.map(sessionId => sessionRepository.findById(sessionId)));

      const invalidSessions: string[] = [];
      const unauthorizedSessions: string[] = [];

      sessions.forEach((session, index) => {
        const sessionId = sessionIds[index];
        if (!session) {
          invalidSessions.push(sessionId);
        } else if (session.userId !== userId) {
          unauthorizedSessions.push(sessionId);
        }
      });

      if (invalidSessions.length > 0) {
        return res.status(404).json({
          success: false,
          message: `Session(s) not found: ${invalidSessions.join(', ')}`,
        });
      }

      if (unauthorizedSessions.length > 0) {
        return res.status(403).json({
          success: false,
          message: `You do not have permission to curate session(s): ${unauthorizedSessions.join(', ')}`,
        });
      }

      const curationJobs = sessionIds.map((sessionId, index) => ({
        sessionId,
        curationJobId: uuidv4(),
        batchIndex: index,
      }));

      // Publish start events for each session
      await Promise.all(
        curationJobs.map(({ sessionId, curationJobId, batchIndex }) =>
          NotebookCurationEvents.Start.publish({
            sessionId,
            userId,
            curationJobId,
            batchJobId,
            batchIndex,
            batchTotal,
            curationType,
            artifactTypes,
            exportFormat,
            customNotebookName,
          })
        )
      );

      // Return batch job info for WebSocket progress tracking
      return res.status(202).json({
        success: true,
        message: `Batch curation started for ${batchTotal} session(s). Listen for progress updates via WebSocket.`,
        data: {
          batchJobId,
          sessionIds,
          curationJobs: curationJobs.map(job => ({
            sessionId: job.sessionId,
            curationJobId: job.curationJobId,
            status: 'pending',
          })),
          batchTotal,
        },
      });
    } catch (error) {
      req.logger.error('Failed to trigger batch notebook curation', { sessionIds, userId, error });

      return res.status(500).json({
        success: false,
        message: 'Failed to start curation. Please try again later.',
      });
    }
  })
);

export default handler;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
    externalResolver: true,
  },
};
