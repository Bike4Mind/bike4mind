import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@server/utils/errors';
import { organizationRepository } from '@bike4mind/database';
import { groupRepository } from '@bike4mind/database/social';
import { userRepository } from '@bike4mind/database/auth';
import { organizationService } from '@bike4mind/services';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';

/**
 * DELETE /api/organizations/[id]/groups/[groupId]/members/[userId] - unassign a user from a group.
 * Authorization + the "group belongs to this org" invariant are enforced in `removeUserFromGroup`.
 */
const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id?: string; groupId?: string; userId?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    const groupId = req.query.groupId;
    const userId = req.query.userId;
    if (!organizationId || !groupId || !userId) {
      throw new BadRequestError('Organization id, group id, and user id are required');
    }

    await organizationService.removeUserFromGroup(
      req.user!,
      { organizationId, groupId, userId },
      { db: { organizations: organizationRepository, groups: groupRepository, users: userRepository } }
    );

    // "Who removed user X from the group" - best-effort, never fails the write.
    await logAuditEvent(
      {
        userId: req.user!.id,
        action: AdminOrgAuditEvents.ORG_GROUP_MEMBER_UNASSIGNED,
        ip: req.ip,
        userAgent: req.headers['user-agent'] || 'unknown',
        metadata: { organizationId, groupId, targetUserId: userId },
      },
      req.logger
    );

    res.status(200).json({ success: true });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
