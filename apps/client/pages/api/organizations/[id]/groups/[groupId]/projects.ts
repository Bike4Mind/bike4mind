import { organizationRepository, projectRepository, withTransaction } from '@bike4mind/database';
import { groupRepository } from '@bike4mind/database/social';
import { organizationService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import { recordOrganizationAuditEvent } from '@bike4mind/server-utils/utils/organizationAudit';

const handler = baseApi({ auth: 'jwtOnly' }).put(
  asyncHandler<{}, unknown, unknown, { id?: string; groupId?: string }>(async (req, res) => {
    const organizationId = req.query.id?.toLowerCase();
    const groupId = req.query.groupId?.toLowerCase();
    if (!organizationId || !groupId) throw new NotFoundError('Group not found');
    const body = z
      .object({
        projectId: z
          .string()
          .regex(/^[a-f\d]{24}$/i)
          .transform(value => value.toLowerCase()),
        enabled: z.boolean(),
      })
      .strict()
      .parse(req.body);
    await withTransaction(async () => {
      await organizationService.shareGroupProject(
        req.user,
        { organizationId, groupId, ...body },
        { db: { organizations: organizationRepository, groups: groupRepository, projects: projectRepository } }
      );
      await recordOrganizationAuditEvent({
        organizationId,
        actorUserId: req.user.impersonatedBy ?? req.user.id,
        action: 'policy.updated',
        targetId: body.projectId,
      });
    });
    res.status(200).json({ success: true });
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
