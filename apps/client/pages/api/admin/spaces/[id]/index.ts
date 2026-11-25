import type { Request } from 'express';
import { ApiKeyScope, BadRequestError, NotFoundError } from '@bike4mind/common';
import {
  inviteRepository,
  orgDomainClaimRepository,
  spaceRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { spaceService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { assertFullAdminForSpaces, notifyOwnerSpaceDeletedByAdmin } from '@server/spaces/adminSpaces';
import { toAdminSpaceView } from '@server/spaces/spaceAccess';

const readSpaceId = (req: Request): string => {
  const { id } = req.query;
  if (typeof id !== 'string' || !id) throw new BadRequestError('Space id required');
  return id;
};

/** One Space for the platform admin: owner, members with email and role, domain claims and pending invites. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'users:moderate', DELETE: 'users:moderate' },
})
  .get(async (req, res) => {
    assertFullAdminForSpaces(req.user);
    const space = await spaceRepository.findLiveById(readSpaceId(req));
    if (!space) throw new NotFoundError('Space not found');

    const [users, claims, invites] = await Promise.all([
      userRepository.findByIds([space.ownerUserId, ...space.members.map(member => member.userId)]),
      orgDomainClaimRepository.listBySpace(space.id),
      inviteRepository.findAllByDocumentId(space.id),
    ]);
    const pendingInviteCount = invites
      .filter(invite => !invite.revokedAt)
      .reduce((sum, invite) => sum + (invite.recipients?.pending?.length ?? 0), 0);

    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({
      space: toAdminSpaceView(space, users),
      domains: claims.map(claim => ({
        id: claim.id,
        domain: claim.domain,
        status: claim.status,
        policy: claim.policy,
      })),
      pendingInviteCount,
    });
  })
  .delete(async (req, res) => {
    assertFullAdminForSpaces(req.user);
    const spaceId = readSpaceId(req);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const deleted = await withTransaction(async () => {
      const space = await spaceService.adminRemove(
        req.user,
        { spaceId },
        { db: { spaces: spaceRepository, invites: inviteRepository, orgDomainClaims: orgDomainClaimRepository } }
      );
      await recordAdminActionFromRequest(req, {
        action: 'space.deleted',
        target: { kind: 'space', id: space.id, displayName: space.name },
        summary: `deleted Space ${space.name}`,
        reason,
        details: { memberCount: space.members.length + 1, ownerUserId: space.ownerUserId },
      });
      return space;
    });

    // After the commit, so a retried transaction cannot notify twice.
    await notifyOwnerSpaceDeletedByAdmin(deleted, req.logger);
    return res.json({ id: deleted.id });
  });

export const config = { api: { externalResolver: true } };
export default handler;
