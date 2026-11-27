import { accessibleBy } from '@casl/mongoose';
import {
  ApiKeyScope,
  Permission,
  sessionSearchSchema,
  SessionEvents,
  redactSessionsForClient,
} from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { assertApiKeyScope } from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';
import qs from 'qs';
import { Request } from 'express';
import { sessionService } from '@bike4mind/services';
import { Session as SessionModel, sessionRepository } from '@bike4mind/database/auth';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { unpublishUserArtifactsBySource } from '@bike4mind/server-utils/services/publish/purgeUserPublishedArtifacts';
import { purgeDeletedNotebookMedia } from '@bike4mind/server-utils/sessions/purgeDeletedNotebookMedia';
import { decodeOwnSessionListCursor, encodeOwnSessionListCursor } from '@server/sessions/ownSessionListCursor';

// Door admits either notebook scope or admin:*; DELETE narrows to notebooks:write (or admin:*) below.
// The door admits legacy keys until the legacy window ends, since GET was open to every key before.
// DELETE never grandfathers: it already required notebooks:write before the door existed.
const handler = baseApi({
  requiredScopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS, ApiKeyScope.ADMIN],
  grandfatherLegacyKeys: true,
})
  /**
   * Get all sessions
   */
  .get<Request<unknown, unknown, unknown, Record<string, string>>>(
    asyncHandler(async (req, res) => {
      const { search, surface, pagination, orderBy, origin, excludeOrigin, hasImages, cursor } =
        sessionSearchSchema.parse(qs.parse(req.query));
      if (!req.user) return res.json([]);

      // Same defaults as searchOwnSessions, so the cursor scope names the order actually served.
      const order = { field: orderBy?.field ?? 'lastUpdated', direction: orderBy?.direction ?? 'desc' } as const;
      const after = cursor === undefined ? undefined : decodeOwnSessionListCursor(cursor, order);

      const result = await sessionService.searchOwnSessions(
        req.user.id,
        { search, surface, pagination, orderBy: order, origin, excludeOrigin, hasImages },
        { db: { sessions: sessionRepository } },
        { after }
      );
      // Redact server-owned fields (e.g. systemPromptText) from the listed sessions.
      return res.json({
        data: redactSessionsForClient(result.data),
        hasMore: result.hasMore,
        nextCursor: encodeOwnSessionListCursor(result.last, order),
      });
    })
  )
  /**
   * Delete all sessions
   */
  .delete(
    asyncHandler(async (req, res) => {
      assertApiKeyScope(
        req,
        [ApiKeyScope.WRITE_NOTEBOOKS, ApiKeyScope.ADMIN],
        'This API key is read-only for notebooks; notebooks:write is required'
      );
      const userId = req.user?.id;
      if (!userId || !req.ability?.can(Permission.delete, SessionModel)) {
        return res.status(403).send({ message: 'Forbidden' });
      }
      const ownedFilter = {
        userId,
        ...accessibleBy(req.ability, Permission.delete).ofType(SessionModel),
      };
      // Published replies are snapshots that outlive their notebook, so take them down first: a
      // retry after a failed delete still finds the notebooks and finishes the job.
      const sessionIds = (await SessionModel.find(ownedFilter).select('_id').lean()).map(s => String(s._id));
      await unpublishUserArtifactsBySource(userId, { kind: 'reply', sessionIds }, { logger: req.logger });
      const deleteResult = await SessionModel.deleteMany(ownedFilter);
      await purgeDeletedNotebookMedia(sessionIds, { logger: req.logger });

      await logEvent({
        userId,
        type: SessionEvents.DELETE_ALL_SESSIONS,
        metadata: { sessionCount: deleteResult.deletedCount },
      });
      return res.status(204).send();
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
