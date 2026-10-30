import { z } from 'zod';
import {
  SIGNUP_TIMESERIES_RANGES,
  SIGNUP_TZ_OFFSET_MESSAGE,
  signupTzOffsetSchema,
} from '@client/app/utils/signupSignals';
import { baseApi } from '@server/middlewares/baseApi';
import { getSignupTimeseries } from '@server/users/signupTimeseries';

const querySchema = z.object({
  range: z.enum(SIGNUP_TIMESERIES_RANGES).default('30d'),
  tzOffset: signupTzOffsetSchema,
});

export default baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  if (!req.user?.isAdmin) return res.status(403).json({ message: 'Admin access required' });
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    const message =
      parsed.error.issues[0]?.path[0] === 'tzOffset'
        ? SIGNUP_TZ_OFFSET_MESSAGE
        : 'Range must be one of 24h, 7d, 30d or 90d.';
    return res.status(400).json({ message });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await getSignupTimeseries({ range: parsed.data.range, tzOffsetMinutes: parsed.data.tzOffset }));
});

export const config = { api: { externalResolver: true } };
