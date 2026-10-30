import { z } from 'zod';
import { PHONE_UNLOCK_CODE_PATTERN } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { runNoCardUnlock } from '@server/noCardUnlock/runNoCardUnlock';

const VerifySchema = z.object({ code: z.string().regex(PHONE_UNLOCK_CODE_PATTERN) });

const handler = baseApi({ auth: 'jwtOnly' }).post(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = VerifySchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError('code must be 4 to 10 digits');
  return res.status(200).json(await runNoCardUnlock('phone_verified', req.user.id, { phoneCode: parsed.data.code }));
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
