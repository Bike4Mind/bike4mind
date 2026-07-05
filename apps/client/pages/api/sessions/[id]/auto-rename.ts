import { questRepository, sessionRepository } from '@bike4mind/database';
import { redactSessionForClient } from '@bike4mind/common';
import { sessionService } from '@bike4mind/services';
import { InternalServerError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { OperationsModelService } from '@client/services/operationsModelService';
import { Request } from 'express';

const handler = baseApi().post<Request<unknown, unknown, unknown, { id: string }>>(async (req, res) => {
  const { id } = req.query;

  try {
    // Get operations model
    const { modelId, llm } = await OperationsModelService.getOperationsModel();

    const updatedSession = await sessionService.autoName(
      { sessionId: id },
      {
        db: {
          sessions: sessionRepository,
          quests: questRepository,
        },
        createCompletion: async (prompt: string) => {
          let result = '';
          await llm.complete(
            modelId,
            [{ role: 'user', content: prompt }],
            { maxTokens: 600 },
            async (chunks: (string | null | undefined)[]) => {
              result += chunks.filter(Boolean).join('');
            }
          );

          const title = result.trim();
          if (!title) throw new InternalServerError('Failed to generate name');
          return title;
        },
        logger: req.logger,
      }
    );

    return res.json(redactSessionForClient(updatedSession));
  } catch (error) {
    req.logger.error('Error in auto-rename:', error);
    throw new InternalServerError('Failed to auto-rename session');
  }
});

export default handler;
