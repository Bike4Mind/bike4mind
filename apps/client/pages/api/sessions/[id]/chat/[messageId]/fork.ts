import {
  questRepository,
  sessionRepository,
  userRepository,
  projectRepository,
  withTransaction,
  fabFileRepository,
} from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { sessionService } from '@bike4mind/services';
import { redactSessionForClient } from '@bike4mind/common';
import { stampGear } from '@server/services/gears/stampGear';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string; messageId?: string }>(async (req, res) => {
    const { id: sessionId, messageId } = req.query;
    if (!sessionId || !messageId) throw new Error('Session and Message ID is required');
    const newSession = await withTransaction(async () =>
      sessionService.forkSession(
        req.user.id,
        {
          sessionId: sessionId,
          messageId,
        },
        {
          db: {
            users: userRepository,
            sessions: sessionRepository,
            chatHistories: questRepository,
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

    stampGear(req.user.id, 'forknotebook');
    return res.json(redactSessionForClient(newSession));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
