// POST /api/spaces/:id/transfer-ownership - owner only.
import { organizationRepository, spaceRepository, userRepository, withTransaction } from '@bike4mind/database';
import { spaceService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { loadSpaceView } from '@server/spaces/spaceAccess';
import { z } from 'zod';

const bodySchema = z.object({ newOwnerId: z.string().min(1) });

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const { newOwnerId } = bodySchema.parse(req.body);
      await withTransaction(() =>
        spaceService.transferOwnership(
          req.user!,
          { spaceId: req.query.id ?? '', newOwnerId },
          { db: { spaces: spaceRepository, organizations: organizationRepository, users: userRepository } }
        )
      );
      res.json(await loadSpaceView(req.user!, req.query.id));
    })
  );

export default handler;
