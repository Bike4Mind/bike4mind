import { sessionService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import {
  fabFileRepository,
  projectRepository,
  questRepository,
  Session,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { BadRequestError } from '@server/utils/errors';
import { logEvent } from '@server/utils/analyticsLog';
import { SessionEvents, redactSessionForClient } from '@bike4mind/common';
import { Request } from 'express';

const handler = baseApi().post(async (req: Request<{}, {}, {}, { id?: string }>, res) => {
  const { id } = req.user;
  const { id: sessionId } = req.query;

  if (!sessionId) {
    throw new BadRequestError('Session ID is required');
  }

  if (!req.ability!.can('clone', Session)) {
    throw new Error('User does not have permission to clone sessions');
  }

  const newSession = await withTransaction(async () =>
    sessionService.cloneSession(
      id,
      {
        id: sessionId,
      },
      {
        db: {
          sessions: sessionRepository,
          chatHistories: questRepository,
          users: userRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
        },
        // Lets a non-owner's lake-tag derivation intersect against THEIR reachable lakes, instead of
        // persisting a tag scraped off a shared file for a lake they cannot read. Lazy import: the
        // resolver's graph reaches the entitlement and Mongoose layers, and the thunk only fires when
        // the derivation actually runs (files attached AND no scope inherited), so the common path
        // pays nothing - including inside the surrounding transaction.
        resolveLakeAccess: async () =>
          (await import('@server/dataLakes/resolveRetrievalLakeScope')).resolveRetrievalLakeScope(req),
      }
    )
  );

  await logEvent(
    {
      userId: id,
      type: SessionEvents.CLONE_SESSION,
      metadata: {
        sessionId: sessionId,
        newSessionId: newSession.id,
        sessionName: newSession.name,
        knowledgeIds: newSession.knowledgeIds ?? [],
        agentIds: newSession.agentIds ?? [],
      },
    },
    { ability: req.ability }
  );

  return res.json(redactSessionForClient(newSession));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
