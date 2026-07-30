import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@server/utils/errors';
import { organizationRepository } from '@bike4mind/database';
import { groupRepository } from '@bike4mind/database/social';
import { userRepository } from '@bike4mind/database/auth';
import { organizationService } from '@bike4mind/services';
import { z } from 'zod';

/**
 * POST /api/organizations/[id]/groups/[groupId]/members - assign a user to a group.
 * Authorization (billing owner / org admin / platform admin) AND the write-path invariant
 * (group belongs to this org, target user is a member) are enforced in `assignUserToGroup`.
 */
const bodySchema = z.object({ userId: z.string().min(1) });

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string; groupId?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    const groupId = req.query.groupId;
    if (!organizationId || !groupId) throw new BadRequestError('Organization id and group id are required');

    let userId: string;
    try {
      ({ userId } = bodySchema.parse(req.body));
    } catch (error) {
      if (error instanceof z.ZodError) throw new BadRequestError('A userId is required');
      throw error;
    }

    await organizationService.assignUserToGroup(
      req.user!,
      { organizationId, groupId, userId },
      { db: { organizations: organizationRepository, groups: groupRepository, users: userRepository } }
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
