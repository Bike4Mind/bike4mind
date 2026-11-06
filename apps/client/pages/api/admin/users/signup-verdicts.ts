import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import {
  SIGNUP_TIMESERIES_RANGES,
  SIGNUP_TZ_OFFSET_MESSAGE,
  SIGNUP_VERDICTS_MAX_IDS,
  signupTzOffsetSchema,
} from '@client/app/utils/signupSignals';
import { getSignupVerdicts } from '@server/users/signupTimeseries';

// ms. Room for clock skew between the server that answered the chart and this one.
const AS_OF_FUTURE_SKEW_MS = 60_000;
// ms. Bounds how far back a request can make the server classify; the column's Retry reloads the chart.
const AS_OF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const querySchema = z.object({
  range: z.enum(SIGNUP_TIMESERIES_RANGES),
  tzOffset: signupTzOffsetSchema,
  // The chart response's `until`, so the verdicts classify the cohort the chart counted.
  asOf: z
    .string()
    .datetime()
    .transform(value => new Date(value))
    .refine(asOf => {
      const age = Date.now() - asOf.getTime();
      return age >= -AS_OF_FUTURE_SKEW_MS && age <= AS_OF_MAX_AGE_MS;
    }),
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

const FIELD_MESSAGES: Record<string, string> = {
  range: 'range must be one of 24h, 7d, 30d or 90d.',
  tzOffset: SIGNUP_TZ_OFFSET_MESSAGE,
  asOf: "asOf must be the signup chart's until instant from the last 24 hours.",
  ids: `ids must be 1 to ${SIGNUP_VERDICTS_MAX_IDS} comma-separated user ids.`,
};

/**
 * The signup chart's verdict for a page of the Users list: GET /api/admin/users/signup-verdicts.
 * Separate from the list so classifying the range never slows or fails the list itself.
 */
export default baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  // Lower than the list's limit: each miss classifies the whole range (see classifyCohort).
  .use(rateLimit({ limit: 30, windowMs: 60_000, bucket: 'admin-users-signup-verdicts' }))
  .get(async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ message: 'Admin access required' });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'ids');
      return res.status(400).json({ message: FIELD_MESSAGES[field] ?? FIELD_MESSAGES.ids });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    const { range, tzOffset, asOf, ids } = parsed.data;
    return res.json(await getSignupVerdicts({ range, tzOffsetMinutes: tzOffset, userIds: ids }, asOf));
  });

export const config = { api: { externalResolver: true } };
