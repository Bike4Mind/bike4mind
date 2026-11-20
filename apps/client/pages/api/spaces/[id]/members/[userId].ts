// DELETE/PATCH /api/spaces/:id/members/:userId - remove a member; change a member's role (owner only).
import { inviteRepository, spaceRepository, userRepository, withTransaction } from '@bike4mind/database';
import { spaceService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { loadSpaceView } from '@server/spaces/spaceAccess';
import { z } from 'zod';

const roleBodySchema = z.object({ role: z.enum(['admin', 'member']) });

type Query = { id?: string; userId?: string };

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .delete(
    asyncHandler<{}, unknown, unknown, Query>(async (req, res) => {
      await withTransaction(() =>
        spaceService.removeMember(
          req.user!,
          { spaceId: req.query.id ?? '', userId: req.query.userId ?? '' },
          { db: { spaces: spaceRepository, invites: inviteRepository, users: userRepository } }
        )
      );
      res.status(204).end();
    })
  )
  .patch(
    asyncHandler<{}, unknown, unknown, Query>(async (req, res) => {
      const { role } = roleBodySchema.parse(req.body);
      await withTransaction(() =>
        spaceService.setMemberRole(
          req.user!,
          { spaceId: req.query.id ?? '', userId: req.query.userId ?? '', role },
          { db: { spaces: spaceRepository } }
        )
      );
      res.json(await loadSpaceView(req.user!, req.query.id));
    })
  );

export default handler;
