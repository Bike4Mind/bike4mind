// POST /api/spaces/:id/leave
import { spaceRepository, withTransaction } from '@bike4mind/database';
import { spaceService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      await withTransaction(() =>
        spaceService.leave(req.user!, { spaceId: req.query.id ?? '' }, { db: { spaces: spaceRepository } })
      );
      res.status(204).end();
    })
  );

export default handler;
