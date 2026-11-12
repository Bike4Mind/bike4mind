// DELETE /api/organizations/:id/invite-links/:inviteId
// Revoke an Organization share link. accept.ts refuses a revoked invite before any other check.

import { InviteType, isLinkOnlyInvite } from '@bike4mind/common';
import { inviteRepository } from '@bike4mind/database';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { loadManagedOrganization, toOrgInviteLinkView } from '@server/organizations/orgInviteLinks';

const handler = baseApi({ auth: 'jwtOnly' }).delete(
  asyncHandler<{}, unknown, unknown, { id?: string; inviteId?: string }>(async (req, res) => {
    const organization = await loadManagedOrganization(req.user!, req.query.id);
    const inviteId = req.query.inviteId;
    if (!inviteId) throw new NotFoundError('Invite link not found');

    const invite = await inviteRepository.findById(inviteId);
    // Only this organization's share links; a named invite or another document's invite is not here.
    if (
      !invite ||
      invite.documentId !== organization.id ||
      invite.type !== InviteType.Organization ||
      !isLinkOnlyInvite(invite)
    ) {
      throw new NotFoundError('Invite link not found');
    }

    const revoked = await inviteRepository.markRevoked(invite.id);
    if (!revoked) throw new NotFoundError('Invite link not found');
    await recordAdminActionFromRequest(req, {
      action: 'org.invite_link.revoked',
      actorScope: 'organization',
      target: { kind: 'organization', id: organization.id, displayName: organization.name },
      summary: 'revoked an organization share link',
      details: { inviteId: invite.id },
    });
    res.json(toOrgInviteLinkView(revoked));
  })
);

export default handler;
