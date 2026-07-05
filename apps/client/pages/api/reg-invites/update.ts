import { IRegInviteDocument } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { RegInviteEvents } from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';
import { registrationInviteRepository } from '@bike4mind/database';

// Placeholder schema; only status is currently used.
const UpdateRegisterInviteSchema = z.object({
  status: z.string().optional(),
});

const handler = baseApi().post(
  asyncHandler<unknown, unknown, { ids: string[] }>(async (req, res) => {
    const ids = req.body.ids;
    const user = req.user;

    const validatedData = UpdateRegisterInviteSchema.parse(req.body) as Partial<IRegInviteDocument>;
    if (!ids) throw new Error('No ids provided');

    if (!user.isAdmin) {
      throw new ForbiddenError('Permission denied');
    }

    const updatedInvites = await registrationInviteRepository.formatRegInvites(validatedData, ids);

    await logEvent(
      {
        userId: user.id,
        type: RegInviteEvents.UPDATE_REGINVITE,
        metadata: { ids, status: validatedData.status || '' },
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
