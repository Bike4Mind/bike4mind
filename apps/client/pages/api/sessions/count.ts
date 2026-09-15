import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { sessionService } from '@bike4mind/services';
import { sessionRepository } from '@bike4mind/database/auth';

const handler = baseApi()
  /**
   * Get session count for the authenticated user
   */
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user) {
        return res.json({ count: 0 });
      }

      const result = await sessionService.countOwnSessions(req.user.id, {
        db: {
          sessions: sessionRepository,
        },
      });

      return res.json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
