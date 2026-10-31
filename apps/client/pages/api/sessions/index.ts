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
import { unpublishUserArtifactsBySource } from '@server/services/publish/purgeUserPublishedArtifacts';

const handler = baseApi()
  /**
   * Get all sessions
   */
  .get<Request<unknown, unknown, unknown, Record<string, string>>>(
    asyncHandler(async (req, res) => {
      const { search, surface, pagination, orderBy, origin, excludeOrigin, hasImages } = sessionSearchSchema.parse(
        qs.parse(req.query)
      );

      const result = req.user
        ? await sessionService.searchOwnSessions(
            req.user.id,
            {
              search,
              surface,
              pagination,
              orderBy,
              origin,
              excludeOrigin,
              hasImages,
            },
            {
              db: {
                sessions: sessionRepository,
              },
            }
          )
        : [];
      // Redact server-owned fields (e.g. systemPromptText) from the listed sessions.
      // Redact in both shapes ({ data, hasMore } and the bare-array fallback) so the redaction
      // can't be bypassed if the service is ever refactored to return a populated array.
      return res.json(
        Array.isArray(result)
          ? redactSessionsForClient(result)
          : { ...result, data: redactSessionsForClient(result.data) }
      );
    })
  )
  /**
   * Delete all sessions
   */
  .delete(
    asyncHandler(async (req, res) => {
      // Gated per verb, not at the door: GET above is the notebook list that notebooks:read and
      // unscoped keys rely on, so a route-level requiredScopes would newly deny them.
      assertApiKeyScope(
        req,
        [ApiKeyScope.WRITE_NOTEBOOKS],
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
