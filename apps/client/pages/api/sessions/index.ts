import { accessibleBy } from '@casl/mongoose';
import { Permission, searchSchema, SessionEvents, redactSessionsForClient } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import qs from 'qs';
import { Request } from 'express';
import { sessionService } from '@bike4mind/services';
import { Session as SessionModel, sessionRepository } from '@bike4mind/database/auth';
import { logEvent } from '@server/utils/analyticsLog';

const handler = baseApi()
  /**
   * Get all sessions
   */
  .get<Request<unknown, unknown, unknown, Record<string, string>>>(
    asyncHandler(async (req, res) => {
      const { search, surface, pagination, orderBy } = searchSchema.parse(qs.parse(req.query));

      const result = req.user
        ? await sessionService.searchOwnSessions(
            req.user.id,
            {
              search,
              surface,
              pagination,
              orderBy,
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
      const userId = req.user?.id;
      if (!req.ability?.can(Permission.delete, SessionModel)) {
        return res.status(403).send({ message: 'Forbidden' });
      }
      const deleteResult = await SessionModel.deleteMany({
        userId,
        ...accessibleBy(req.ability, Permission.delete).ofType(SessionModel),
      });

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
