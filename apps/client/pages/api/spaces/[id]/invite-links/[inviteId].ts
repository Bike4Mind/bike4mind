// DELETE /api/spaces/:id/invite-links/:inviteId - revoke a Space join link. Managers only.

import { InviteType, isLinkOnlyInvite } from '@bike4mind/common';
import { inviteRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { loadManagedSpace, toSpaceInviteLinkView } from '@server/spaces/spaceAccess';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string; inviteId?: string }>(async (req, res) => {
      const space = await loadManagedSpace(req.user!, req.query.id);
      const inviteId = req.query.inviteId;
      if (!inviteId) throw new NotFoundError('Invite link not found');

      const invite = await inviteRepository.findById(inviteId);
      if (!invite || invite.documentId !== space.id || invite.type !== InviteType.Space || !isLinkOnlyInvite(invite)) {
        throw new NotFoundError('Invite link not found');
      }
      const revoked = await inviteRepository.markRevoked(invite.id);
      if (!revoked) throw new NotFoundError('Invite link not found');
      res.json(toSpaceInviteLinkView(revoked));
    })
  );

export default handler;
