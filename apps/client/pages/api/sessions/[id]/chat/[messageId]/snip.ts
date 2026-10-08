import {
  agentRepository,
  questRepository,
  sessionRepository,
  userRepository,
  projectRepository,
  withTransaction,
  fabFileRepository,
} from '@bike4mind/database';
import { sessionService } from '@bike4mind/services';
import { redactSessionForClient } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { surfaceAccessForRequest } from '@server/entitlements/surfaceAccess';
import { parseTargetSurface } from '@server/utils/parseTargetSurface';

const handler = baseApi().post(
  asyncHandler<{}, unknown, { targetSurface?: unknown } | undefined, { id?: string; messageId?: string }>(
    async (req, res) => {
      const { id: sessionId, messageId } = req.query;
      if (!sessionId || !messageId) throw new Error('Session and Message ID is required');
      const targetSurface = parseTargetSurface(req.body);
      const newSession = await withTransaction(async () =>
        sessionService.snipSession(
          req.user.id,
          {
            sessionId: sessionId,
            messageId,
            targetSurface,
          },
          {
            db: {
              users: userRepository,
              sessions: sessionRepository,
              chatHistories: questRepository,
              projects: projectRepository,
              fabFiles: fabFileRepository,
              agents: agentRepository,
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
            resolveSurfaceAccess: surfaceAccessForRequest(req),
          }
        )
      );

      return res.json(redactSessionForClient(newSession));
    }
  )
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
