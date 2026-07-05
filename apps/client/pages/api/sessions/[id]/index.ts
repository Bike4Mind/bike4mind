import { ISession, SessionEvents, redactSessionForClient } from '@bike4mind/common';
import { sessionService } from '@bike4mind/services';
import {
  projectRepository,
  sessionRepository,
  userRepository,
  fabFileRepository,
  cacheRepository,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { logEvent } from '@server/utils/analyticsLog';
import { Request } from 'express';
import { getFilesStorage } from '@server/utils/storage';

const handler = baseApi()
  /**
   * Get a session by its ID
   */
  .get(async (req: Request<{}, {}, {}, { id: string }>, res) => {
    const sessionId = req.query.id!;

    const session = await sessionService.getSession(
      req.user!.id,
      { id: sessionId },
      { db: { sessions: sessionRepository, users: userRepository } }
    );

    return res.json(redactSessionForClient(session));
  })
  /**
   * Update a session
   */
  .put(async (req: Request<{}, {}, Partial<ISession>, { id?: string }>, res) => {
    // Extract and handle lastUsedModel to prevent null values
    const { lastUsedModel, ...restBody } = req.body;

    const updatedSession = await sessionService.updateSession(
      req.user!,
      {
        ...restBody,
        id: req.query.id!,
        // Only include lastUsedModel if it's not null
        ...(lastUsedModel !== null ? { lastUsedModel } : {}),
      },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
          caches: cacheRepository,
        },
        storage: getFilesStorage(),
      }
    );

    await logEvent(
      {
        userId: req.user.id,
        type: SessionEvents.UPDATE_SESSION,
        metadata: {
          sessionId: req.query.id!,
          sessionName: updatedSession.name,
          knowledgeIds: updatedSession.knowledgeIds ?? [],
          agentIds: updatedSession.agentIds ?? [],
        },
      },
      { ability: req.ability }
    );

    return res.json(redactSessionForClient(updatedSession));
  })
  /**
   * Delete a session
   */
  .delete(async (req: Request<{}, { newLastNotebookId: string | null }, unknown, { id?: string }>, res) => {
    if (!req.query.id) throw new NotFoundError('Session not found');

    const userId = req.user?.id;
    const newLastNotebook = await sessionService.deleteSession(
      userId,
      { id: req.query.id },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
        },
      }
    );

    await logEvent(
      { userId, type: SessionEvents.DELETE_SESSION, metadata: { sessionId: req.query.id } },
      { ability: req.ability }
    );

    return res.json({ newLastNotebookId: newLastNotebook?.id || null });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
