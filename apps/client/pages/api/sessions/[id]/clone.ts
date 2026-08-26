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
        // Lets the lake-tag derivation intersect against the CALLER's reachable lakes, instead of
        // persisting a tag scraped off a merely-readable file for a lake they cannot use. The case that
        // motivated it is a non-owner cloning a shared, lake-scoped session, but it applies to any
        // caller - the ownership arm matches shares, so a foreign tag can reach anyone's derivation.
        //
        // Lazy import so a route that never derives pays no import cost. The thunk itself fires whenever
        // the derivation runs (files attached AND no scope inherited), which is NOT rare: a plain
        // fork/snip/clone of a notebook that holds files but names no lake reaches it, and then costs a
        // handful of reads inside the transaction this route opens. That is the intended trade - the
        // alternative is persisting an unreachable scope, which is permanent once non-empty.
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
