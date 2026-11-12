// POST /api/organizations/:id/invite-resend
// Email a pending organization invitation again. Each invite+address can be resent once per
// cooldown window, and every resend is charged against the inviter's normal send budget.

import { InviteType, type IInviteDocument } from '@bike4mind/common';
import { cacheRepository, inviteRepository, userRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { TooManyRequestsError } from '@bike4mind/utils';
import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { generateInviteLink } from '@server/managers/createDocumentInvite';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { loadManagedOrganization } from '@server/organizations/orgInviteLinks';
import { notifyInvitees, reserveInviteSendBudget } from '@server/utils/inviteSendLimits';
import { getInviteTypeName } from '@server/utils/mailer/inviteNotificationEmail';
import { z } from 'zod';

export const INVITE_RESEND_COOLDOWN_MS = 10 * 60 * 1000;

// The members list names a pending account by user id and a typed address by email. Pending
// recipients are stored as lowercased addresses either way, so a user id resolves to its address
// first, the same way sharingService/cancel.ts does.
const bodySchema = z
  .object({ email: z.string().max(320).optional(), userId: z.string().max(64).optional() })
  .refine(body => !!body.email !== !!body.userId, 'Provide exactly one of email or userId');

const isOpenOrgInvite = (invite: IInviteDocument, organizationId: string, now: Date) =>
  invite.type === InviteType.Organization &&
  invite.documentId === organizationId &&
  !invite.revokedAt &&
  invite.remaining > 0 &&
  (!invite.expiresAt || new Date(invite.expiresAt) > now);

const handler = baseApi({ auth: 'jwtOnly' }).post(
  outboundActionGate(),
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const user = req.user!;
    const organization = await loadManagedOrganization(user, req.query.id);
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');

    let address = parsed.data.email?.trim().toLowerCase() ?? '';
    if (parsed.data.userId) {
      const invitee = await userRepository.findById(parsed.data.userId);
      if (!invitee?.email) throw new NotFoundError('Pending invitation not found');
      address = invitee.email.trim().toLowerCase();
    }

    const now = new Date();
    const invites = await inviteRepository.findAllByDocumentId(organization.id);
    const invite = invites
      .filter(candidate => isOpenOrgInvite(candidate, organization.id, now))
      .find(candidate =>
        (candidate.recipients?.pending ?? []).some(recipient => recipient.trim().toLowerCase() === address)
      );
    if (!invite) throw new NotFoundError('Pending invitation not found');

    // Only a typed address was charged to the typed-address budget when the invite was created. Every
    // org invite resend, single or bulk-sent, draws on the org-bulk bucket shared with bulk-invite.ts.
    const budget = await reserveInviteSendBudget(user.id, [address], {
      chargeTypedAddresses: !parsed.data.userId,
      typedAddressBucket: 'orgBulk',
    });
    const cooldownKey = `rate-limit:invite-resend:${invite.id}:${address}`;
    const cooldown = await cacheRepository.tryAddWithinLimitFixedWindow(cooldownKey, 1, 1, INVITE_RESEND_COOLDOWN_MS);
    if (!cooldown.success) {
      await budget.release();
      throw new TooManyRequestsError('This invitation was resent recently. Try again in a few minutes.');
    }

    try {
      await notifyInvitees({
        recipients: [address],
        sharerName: user.name || user.username || 'A user',
        sharerEmail: user.email || '',
        documentName: organization.name || 'an organization',
        typeName: getInviteTypeName(InviteType.Organization),
        inviteLink: generateInviteLink(invite),
        message: invite.description,
      });
    } catch (error) {
      await Promise.all([budget.release(), cacheRepository.decrementCounter(cooldownKey)]);
      throw error;
    }
    res.json({ resent: true });
  })
);

export default handler;
