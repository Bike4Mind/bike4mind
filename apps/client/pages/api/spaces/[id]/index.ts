// GET/PATCH/DELETE /api/spaces/:id
import { organizationRepository, spaceRepository, inviteRepository, withTransaction } from '@bike4mind/database';
import { spaceService } from '@bike4mind/services';
import { SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { loadSpaceView } from '@server/spaces/spaceAccess';
import { z } from 'zod';

const patchBodySchema = z.object({
  name: z.string().trim().min(1).max(SPACE_NAME_MAX).optional(),
  description: z.string().max(SPACE_DESCRIPTION_MAX).nullable().optional(),
  parentOrganizationId: z.string().min(1).nullable().optional(),
});

type Query = { id?: string };

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .get(
    asyncHandler<{}, unknown, unknown, Query>(async (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await loadSpaceView(req.user!, req.query.id));
    })
  )
  .patch(
    asyncHandler<{}, unknown, unknown, Query>(async (req, res) => {
      const body = patchBodySchema.parse(req.body);
      await withTransaction(() =>
        spaceService.update(
          req.user!,
          { spaceId: req.query.id ?? '', ...body },
          { db: { spaces: spaceRepository, organizations: organizationRepository } }
        )
      );
      res.json(await loadSpaceView(req.user!, req.query.id));
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, Query>(async (req, res) => {
      await withTransaction(() =>
        spaceService.remove(
          req.user!,
          { spaceId: req.query.id ?? '' },
          { db: { spaces: spaceRepository, invites: inviteRepository } }
        )
      );
      res.status(204).end();
    })
  );

export default handler;
