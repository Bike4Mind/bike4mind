import { z } from 'zod';
import { PHONE_UNLOCK_INPUT_MAX_LENGTH } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { startPhoneUnlock } from '@server/noCardUnlock/phoneUnlock';

const StartSchema = z.object({ phoneNumber: z.string().min(1).max(PHONE_UNLOCK_INPUT_MAX_LENGTH) });

const handler = baseApi({ auth: 'jwtOnly' }).post(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = StartSchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError('phoneNumber is required');
  return res.status(200).json(await startPhoneUnlock(req.user.id, parsed.data.phoneNumber, req));
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
