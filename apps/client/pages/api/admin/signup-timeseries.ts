import { z } from 'zod';
import { SIGNUP_TIMESERIES_RANGES } from '@client/app/utils/signupSignals';
import { baseApi } from '@server/middlewares/baseApi';
import { getSignupTimeseries } from '@server/users/signupTimeseries';

const querySchema = z.object({
  range: z.enum(SIGNUP_TIMESERIES_RANGES).default('30d'),
  // Minutes east of UTC, so buckets start at the viewer's local hour or midnight.
  tzOffset: z.coerce
    .number()
    .int()
    .min(-14 * 60)
    .max(14 * 60)
    .default(0),
});

export default baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  if (!req.user?.isAdmin) return res.status(403).json({ message: 'Admin access required' });
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ message: 'Range must be one of 24h, 7d, 30d or 90d.' });
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await getSignupTimeseries({ range: parsed.data.range, tzOffsetMinutes: parsed.data.tzOffset }));
});

export const config = { api: { externalResolver: true } };
