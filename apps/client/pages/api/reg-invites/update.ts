import { IRegInviteDocument } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { RegInviteEvents } from '@bike4mind/common';
import { ForbiddenError, parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import { registrationInviteRepository, withTransaction } from '@bike4mind/database';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const MAX_AUDITED_IDS = 100;

// Only status is currently used as an update field.
const UpdateRegisterInviteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  status: z.string().optional(),
});

const handler = baseApi().post(
  asyncHandler<unknown, unknown, unknown>(async (req, res) => {
    const user = req.user;

    if (!user.isAdmin) {
      throw new ForbiddenError('Permission denied');
    }

    const { ids, ...updates } = parseOrBadRequest(UpdateRegisterInviteSchema, req.body);

    const updatedInvites = await withTransaction(async () => {
      const invites = await registrationInviteRepository.formatRegInvites(updates as Partial<IRegInviteDocument>, ids);
      await recordAdminActionFromRequest(req, {
        action: 'user.reg_invite.updated',
        target:
          invites.length === 1
            ? { kind: 'settings', id: invites[0].id, displayName: 'registration invite' }
            : { kind: 'system', id: 'registration_invites', displayName: `${invites.length} registration invites` },
        summary: `updated ${invites.length} registration invite${invites.length === 1 ? '' : 's'}`,
        details: {
          requested: ids.length,
          ids: ids.slice(0, MAX_AUDITED_IDS),
          idsTruncated: ids.length > MAX_AUDITED_IDS,
          status: updates.status ?? null,
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
