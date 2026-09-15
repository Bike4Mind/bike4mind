// PUT /api/organizations/:id/admins
// Set the org's appointed admins (adminUserIds). Billing owner or platform admin only -
// an org admin cannot appoint further admins (org-groups #1172 authorization matrix).

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { organizationRepository } from '@bike4mind/database/infra';
import { orgAclRowConfersMembership } from '@bike4mind/common';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { z } from 'zod';

const bodySchema = z.object({ adminUserIds: z.array(z.string().min(1)).max(50) });

const handler = baseApi().put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    if (!organizationId) throw new BadRequestError('Organization id is required');

    // ZodError propagates to the central errorHandler (422 via fromZodError). No hand-rolled 400.
    const parsed = bodySchema.parse(req.body);
    const adminUserIds = [...new Set(parsed.adminUserIds)];

    const organization = await organizationRepository.findById(organizationId);
    if (!organization) throw new NotFoundError('Organization not found');

    const isOwner = organization.userId === req.user?.id;
    if (!isOwner && !req.user?.isAdmin) {
      throw new ForbiddenError('Only the billing owner or a platform admin can set org admins');
    }

    // An appointed admin must be a member of the org - don't reference outsiders. Membership means
    // an ACL row that actually CONFERS it, not merely a row that exists: checking `userId` alone
    // admitted a row carrying no permissions, which `findMembershipOrgIds` then refused to count as
    // membership, so the appointment silently created a principal that held admin rights over the
    // org while the org was unselectable in their own account switcher (#2005). Same predicate as
    // the read gate, from the shared constant, so the two cannot drift apart again.
    const memberIds = new Set(
      organization.users.filter(member => orgAclRowConfersMembership(member)).map(member => member.userId)
    );

    // The membership requirement binds the appointments this call ADDS. Because the endpoint is a
    // full replace, every sitting admin is resent on every save, so validating the whole set would
    // let one row appointed before this check existed block every later edit of the roster until the
    // operator de-appointed them - a stricter rule turning into a retroactive revocation. Resends of
    // an existing appointment are grandfathered instead; that mints no new principal, and it agrees
    // with the read side, which still serves such an admin. Roster membership itself is NOT waived:
    // a grandfathered id must still hold a users[] row, so removal from the org still ejects them.
    const rosterUserIds = new Set(organization.users.map(member => member.userId));
    const sittingAdminIds = new Set(organization.adminUserIds ?? []);
    const notMembers = adminUserIds.filter(
      userId => !memberIds.has(userId) && !(sittingAdminIds.has(userId) && rosterUserIds.has(userId))
    );
    if (notMembers.length > 0) {
      throw new BadRequestError(`Not organization members with read access: ${notMembers.join(', ')}`);
    }

    const updated = await organizationRepository.update({ id: organizationId, adminUserIds });

    // "Who appointed the person who can reach confidential groups" - the same legal question the
    // group-type grant audit answers, one link up the chain. Best-effort (logAuditEvent swallows
    // its own errors), so it never fails the already-committed change.
    await logAuditEvent(
      {
        userId: req.user!.id,
        action: AdminOrgAuditEvents.ORG_ADMINS_UPDATED,
        ip: req.ip,
        userAgent: req.headers['user-agent'] || 'unknown',
        metadata: { organizationId, adminUserIds },
      },
      req.logger
    );

    return res.status(200).json({ adminUserIds: updated?.adminUserIds ?? adminUserIds });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
