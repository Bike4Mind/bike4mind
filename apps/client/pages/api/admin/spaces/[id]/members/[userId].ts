import type { Request } from 'express';
import { ApiKeyScope, BadRequestError } from '@bike4mind/common';
import { inviteRepository, spaceRepository, userRepository, withTransaction } from '@bike4mind/database';
import { spaceService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import {
  parseAdminActionReason,
  recordAdminActionFromRequest,
  userAuditTarget,
} from '@bike4mind/server-utils/utils/adminAudit';
import { assertFullAdminForSpaces } from '@server/spaces/adminSpaces';

const readParams = (req: Request) => {
  const { id, userId } = req.query;
  if (typeof id !== 'string' || !id || typeof userId !== 'string' || !userId) {
    throw new BadRequestError('Space and user id required');
  }
  return { spaceId: id, userId };
};

/** Removes a non-owner member and blocks them from rejoining by link. No notice goes to the removed member. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { DELETE: 'users:moderate' },
}).delete(async (req, res) => {
  assertFullAdminForSpaces(req.user);
  const { spaceId, userId } = readParams(req);
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

  await withTransaction(async () => {
    const space = await spaceService.adminRemoveMember(
      req.user,
      { spaceId, userId },
      { db: { spaces: spaceRepository, invites: inviteRepository, users: userRepository } }
    );
    const role = space.members.find(member => member.userId === userId)?.role;
    await recordAdminActionFromRequest(req, {
      action: 'space.member.removed',
      target: { kind: 'space', id: space.id, displayName: space.name },
      summary: `removed ${(await userAuditTarget(userId)).displayName} from Space ${space.name}`,
      reason,
      details: { userId, role, spaceName: space.name },
    });
  });

  return res.json({ spaceId, userId });
});

export const config = { api: { externalResolver: true } };
export default handler;
