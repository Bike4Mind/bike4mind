// GET/POST /api/spaces - list the caller's Spaces; create one.
import { organizationRepository, spaceRepository, withTransaction } from '@bike4mind/database';
import { spaceService } from '@bike4mind/services';
import { SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { canCreateSpace } from '@server/spaces/creationGate';
import { loadSpaceView } from '@server/spaces/spaceAccess';
import { z } from 'zod';

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(SPACE_NAME_MAX),
  description: z.string().max(SPACE_DESCRIPTION_MAX).nullish(),
  parentOrganizationId: z.string().min(1).nullish(),
});

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .get(
    asyncHandler(async (req, res) => {
      const spaces = await spaceService.listMine(req.user!, {}, { db: { spaces: spaceRepository } });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(
        spaces.map(space => ({
          id: space.id,
          name: space.name,
          description: space.description ?? null,
          parentOrganizationId: space.parentOrganizationId ?? null,
          memberCount: space.members.length + 1,
          isOwner: space.ownerUserId === req.user!.id,
        }))
      );
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const body = createBodySchema.parse(req.body);
      const canCreate = await canCreateSpace(req.user!);
      const space = await withTransaction(() =>
        spaceService.create(req.user!, body, {
          db: { spaces: spaceRepository, organizations: organizationRepository },
          gate: { canCreate },
        })
      );
      res.status(201).json(await loadSpaceView(req.user!, space.id));
    })
  );

export default handler;
