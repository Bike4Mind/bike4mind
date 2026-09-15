import { referService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { RegInviteEvents } from '@bike4mind/common';
import { registrationInviteRepository } from '@bike4mind/database';
import { z } from 'zod';

const createRegInviteSchema = z.object({
  multiple: z.number().int().min(1, 'At least one invite must be created').max(500),
  unlimitedUse: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(100)).max(20).optional(),
  startingCredits: z.number().int().min(0).max(1_000_000).optional(),
  startingStorage: z.number().int().min(0).max(100_000).optional(),
});

const handler = baseApi().post(
  asyncHandler<unknown, unknown, z.infer<typeof createRegInviteSchema>>(async (req, res) => {
    const {
      multiple,
      unlimitedUse = false,
      tags,
      startingCredits,
      startingStorage,
    } = createRegInviteSchema.parse(req.body);

    let expiresAtDate: Date | undefined;
    if (unlimitedUse) {
      expiresAtDate = new Date();
      expiresAtDate.setMonth(expiresAtDate.getMonth() + 3);
    }

    const results = await referService.generateReferralCodes(
      req.user,
      { count: multiple, unlimitedUse, expiresAt: expiresAtDate, tags, startingCredits, startingStorage },
      { db: { regInvites: registrationInviteRepository } }
    );

    await logEvent(
      { userId: req.user.id, type: RegInviteEvents.CREATE_REGINVITE, metadata: { totalInvites: multiple } },
      { ability: req.ability }
    );

    return res.status(200).json(results);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
