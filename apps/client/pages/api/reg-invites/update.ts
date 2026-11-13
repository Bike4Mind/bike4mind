import { IRegInviteDocument, RegInviteStatusType } from '@bike4mind/common';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { RegInviteEvents } from '@bike4mind/common';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import { registrationInviteRepository, withTransaction } from '@bike4mind/database';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const MAX_AUDITED_IDS = 100;

const UpdateRegisterInviteSchema = z
  .object({
    ids: z.array(z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid invite id')).min(1),
    status: z.nativeEnum(RegInviteStatusType).optional(),
    unlimitedUse: z.boolean().optional(),
    // null clears the expiry; an empty string fails rather than coercing to an invalid date.
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .refine(
    body => body.status !== undefined || body.unlimitedUse !== undefined || body.expiresAt !== undefined,
    'Nothing to update'
  );

type StoredInvite = Pick<IRegInviteDocument, 'unlimitedUse' | 'expiresAt'>;

/** Unlimited use, or a later or removed expiry, lets a package-linked code hand out more of its package. */
const widensRedemption = (stored: StoredInvite, updates: { unlimitedUse?: boolean; expiresAt?: Date | null }) =>
  (updates.unlimitedUse === true && !stored.unlimitedUse) ||
  (updates.expiresAt !== undefined &&
    stored.expiresAt != null &&
    (updates.expiresAt === null || updates.expiresAt.getTime() > new Date(stored.expiresAt).getTime()));

const handler = adminApi({ adminPermissions: { POST: 'settings:manage' } }).post(
  asyncHandler<unknown, unknown, unknown>(async (req, res) => {
    const user = req.user;

    const { ids, ...updates } = parseOrBadRequest(UpdateRegisterInviteSchema, req.body);

    // Same rule as a package edit that widens a grant: the admin states why.
    const packageLinked =
      updates.unlimitedUse === true || updates.expiresAt !== undefined
        ? ((await registrationInviteRepository.find({
            _id: { $in: ids },
            grantPackageId: { $nin: [null, ''] },
          })) as StoredInvite[])
        : [];
    const reason = packageLinked.some(stored => widensRedemption(stored, updates))
      ? parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason)
      : undefined;

    const updatedInvites = await withTransaction(async () => {
      const invites = await registrationInviteRepository.formatRegInvites(updates as Partial<IRegInviteDocument>, ids);
      if (invites.length === 0) return invites;
      await recordAdminActionFromRequest(req, {
        action: 'user.reg_invite.updated',
        target:
          invites.length === 1
            ? { kind: 'settings', id: invites[0].id, displayName: 'registration invite' }
            : { kind: 'settings', id: 'registration_invites', displayName: `${invites.length} registration invites` },
        summary: `updated ${invites.length} registration invite${invites.length === 1 ? '' : 's'}`,
        reason,
        details: {
          requested: ids.length,
          ids: ids.slice(0, MAX_AUDITED_IDS),
          idsTruncated: ids.length > MAX_AUDITED_IDS,
          status: updates.status ?? null,
          ...(updates.unlimitedUse !== undefined && { unlimitedUse: updates.unlimitedUse }),
          ...(updates.expiresAt !== undefined && { expiresAt: updates.expiresAt?.toISOString() ?? null }),
        },
      });
      return invites;
    });

    await logEvent(
      {
        userId: user.id,
        type: RegInviteEvents.UPDATE_REGINVITE,
        metadata: { ids, status: updates.status || '' },
      },
      { ability: req.ability }
    );

    return res.status(200).json(updatedInvites);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
