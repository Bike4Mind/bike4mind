import { organizationRepository, projectRepository, withTransaction } from '@bike4mind/database';
import { groupRepository } from '@bike4mind/database/social';
import { organizationService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';

const handler = baseApi().put(
  asyncHandler<{}, unknown, unknown, { id?: string; groupId?: string }>(async (req, res) => {
    const { id: organizationId, groupId } = req.query;
    if (!organizationId || !groupId) throw new NotFoundError('Group not found');
    const body = z
      .object({ projectId: z.string().regex(/^[a-f\d]{24}$/i), enabled: z.boolean() })
      .strict()
      .parse(req.body);
    await withTransaction(() =>
      organizationService.shareGroupProject(
        req.user,
        { organizationId, groupId, ...body },
        { db: { organizations: organizationRepository, groups: groupRepository, projects: projectRepository } }
      )
    );
    res.status(200).json({ success: true });
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
