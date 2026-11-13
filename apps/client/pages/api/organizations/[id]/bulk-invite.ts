// POST /api/organizations/:id/bulk-invite
// Invite many addresses to an organization in one call, reporting what happened to each row
// instead of failing the whole batch on one existing member, bad address or missing seat.

import {
  InviteType,
  isOrgMember,
  isOrgOwnerOrPlatformAdmin,
  MAX_ORG_BULK_INVITE_ROWS,
  Permission,
  roleForPermissions,
} from '@bike4mind/common';
import { inviteRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { organizationService, sharingService } from '@bike4mind/services';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { createDocumentInvite } from '@server/managers/createDocumentInvite';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const bodySchema = z.object({
  emails: z
    .array(z.string().max(320))
    .min(1, 'Provide at least one email address')
    .max(MAX_ORG_BULK_INVITE_ROWS, `At most ${MAX_ORG_BULK_INVITE_ROWS} email addresses`),
  permissions: z.array(z.enum(Permission)),
});

type BulkOrgInviteResponse = {
  rows: sharingService.OrgInviteRow[];
  invitedCount: number;
  inviteId: string | null;
};

// createInvite's own all-or-nothing checks; reaching them here means the roster changed between
// classification and creation.
const RACE_MESSAGES = new Set(['Organization is full', 'A recipient already has a pending organization invitation']);

const handler = baseApi({ auth: 'jwtOnly' }).post(
  outboundActionGate(),
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    if (!organizationId) throw new BadRequestError('Organization id is required');
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
    const { emails, permissions } = parsed.data;
    const role = roleForPermissions(permissions);
    if (!role) throw new BadRequestError('Invalid role for organization invite');

    const user = req.user!;
    const organization = await organizationRepository.findById(organizationId);
    // Same disclosure guard then authority gate as sharingService.createInvite's organization arm.
    if (!organization || !isOrgMember(user, organization)) throw new NotFoundError('Organization not found');
    organizationService.assertCanManageOrgGroups(user, organization);
    // Repeats createInvite's admin gate before classification, so a batch with nothing invitable
    // still refuses a non-owner rather than returning 200.
    if (role === 'admin' && !isOrgOwnerOrPlatformAdmin(user, organization)) {
      throw new ForbiddenError('Only the organization owner can invite an admin');
    }

    const [members, owner, invites] = await Promise.all([
      userRepository.findByIds(organization.users.map(member => member.userId)),
      userRepository.findById(organization.userId),
      inviteRepository.findAllByDocumentId(organization.id),
    ]);
    // Counted the same way sharingService.createInvite (inviteToOrg) re-checks seats.
    const pending = sharingService.pendingOrgInviteRecipients(invites);

    const rows = sharingService.classifyOrgInviteRows(emails, {
      memberEmails: new Set(members.flatMap(member => (member.email ? [member.email.toLowerCase()] : []))),
      ownerEmail: owner?.email,
      pendingEmails: new Set(pending),
      // The owner holds a seat outside users[].
      availableSeats: organization.seats - (organization.users.length + 1) - pending.length,
    });
    const recipients = rows.filter(row => row.status === 'invite').map(row => row.email);
    if (recipients.length === 0) {
      const response: BulkOrgInviteResponse = { rows, invitedCount: 0, inviteId: null };
      res.json(response);
      return;
    }

    try {
      const invite = await createDocumentInvite(req, {
        type: InviteType.Organization,
        id: organization.id,
        // Built here rather than through createInviteBodySchema, whose recipient cap is the
        // single-invite one; this route's own row cap and the org-bulk send bucket bound it instead.
        body: { permissions, recipients, description: "You've been invited to join the organization" },
        typedAddressBucket: 'orgBulk',
      });
      // createDocumentInvite returns the sharer view, typed as a loose record.
      const createdId: unknown = (invite as Record<string, unknown>).id;
      const response: BulkOrgInviteResponse = {
        rows,
        invitedCount: recipients.length,
        inviteId: typeof createdId === 'string' ? createdId : null,
      };
      res.json(response);
    } catch (error) {
      if (error instanceof Error && RACE_MESSAGES.has(error.message)) {
        throw new ConflictError(`${error.message}. Nothing was sent; review the list and try again.`);
      }
      throw error;
    }
  })
);

export default handler;
