import { SessionEvents, redactSessionForClient, sessionUpdateContract } from '@bike4mind/common';
import { sessionService } from '@bike4mind/services';
import {
  projectRepository,
  sessionRepository,
  userRepository,
  fabFileRepository,
  cacheRepository,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { NotFoundError } from '@server/utils/errors';
import { logEvent } from '@server/utils/analyticsLog';
import { Request, Response } from 'express';
import { getFilesStorage } from '@server/utils/storage';

// baseApi() here and nextRouteForContract(sessionUpdateContract) below build two
// independent router instances (see the dispatcher at the bottom of this file) - both
// currently use default auth/rate-limit options, so keep them that way in lockstep;
// a future option change to one (maxBodySize, exemptReadsFromDailyRateLimit, ...)
// needs the same change made deliberately to the other, not assumed to apply.
const getAndDeleteHandler = baseApi()
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

// Auth mode and request/path-param validation come from sessionUpdateContract (the single
// source of truth also driving the OpenAPI spec). `req.validated` / `req.validatedParams`
// are the parsed, typed body/id. sessionUpdateContract declares no scopes, matching this
// route's pre-existing unscoped behavior (any valid API key or JWT).
const putHandler = nextRouteForContract(sessionUpdateContract).put(async (req, res) => {
  const { id } = req.validatedParams;

  const updatedSession = await sessionService.updateSession(
    req.user!,
    { ...req.validated, id },
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
        sessionId: id,
        sessionName: updatedSession.name,
        knowledgeIds: updatedSession.knowledgeIds ?? [],
        agentIds: updatedSession.agentIds ?? [],
      },
    },
    { ability: req.ability }
  );

  return res.json(redactSessionForClient(updatedSession));
});

// sessionUpdateContract only declares PUT, and nextRouteForContract's router rejects any
// other verb registered on it - so GET/DELETE stay on their own plain baseApi() router and
// this file dispatches by method instead of chaining every verb on one router instance.
export default function handler(req: Request, res: Response) {
  // putHandler's declared param type carries the contract's validated req/params fields,
  // which only exist once its own prelude has run - a plain incoming Request satisfies
  // that at runtime but not structurally, hence the cast.
  if (req.method === 'PUT') return putHandler(req as Parameters<typeof putHandler>[0], res);
  return getAndDeleteHandler(req, res);
}

export const config = {
  api: {
    externalResolver: true,
  },
};
