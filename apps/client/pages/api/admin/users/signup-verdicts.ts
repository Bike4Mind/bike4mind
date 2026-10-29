import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { SIGNUP_TIMESERIES_RANGES, SIGNUP_VERDICTS_MAX_IDS } from '@client/app/utils/signupSignals';
import { getSignupVerdicts } from '@server/users/signupTimeseries';

const querySchema = z.object({
  range: z.enum(SIGNUP_TIMESERIES_RANGES),
  // Minutes east of UTC; must match the chart's, since the range starts at the viewer's local bucket.
  tzOffset: z.coerce
    .number()
    .int()
    .min(-14 * 60)
    .max(14 * 60)
    .default(0),
  ids: z
    .string()
    .transform(value => [...new Set(value.split(','))])
    .pipe(
      z
        .array(z.string().regex(/^[0-9a-f]{24}$/))
        .min(1)
        .max(SIGNUP_VERDICTS_MAX_IDS)
    ),
});

/**
 * The signup chart's verdict for a page of the Users list: GET /api/admin/users/signup-verdicts.
 * Separate from the list so classifying the range never slows or fails the list itself.
 */
export default baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 120, windowMs: 60_000, bucket: 'admin-users-signup-verdicts' }))
  .get(async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ message: 'Admin access required' });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: `Pass range (24h, 7d, 30d or 90d) and 1 to ${SIGNUP_VERDICTS_MAX_IDS} comma-separated user ids.`,
      });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    const { range, tzOffset, ids } = parsed.data;
    return res.json(await getSignupVerdicts({ range, tzOffsetMinutes: tzOffset, userIds: ids }));
  });

export const config = { api: { externalResolver: true } };
