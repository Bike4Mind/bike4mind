import { z } from 'zod';
import { ApiKeyScope, MODERATION_PAGE_READ } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  SIGNUP_TIMESERIES_RANGES,
  SIGNUP_TZ_OFFSET_MESSAGE,
  SIGNUP_VERDICTS_MAX_IDS,
  signupTzOffsetSchema,
} from '@bike4mind/server-utils/app/utils/signupSignals';
import { getSignupVerdicts } from '@bike4mind/server-utils/users/signupTimeseries';

// ms. Room for clock skew between the server that answered the chart and this one.
const AS_OF_FUTURE_SKEW_MS = 60_000;
// ms. Bounds how far back a request can make the server classify; the column's Retry reloads the chart.
const AS_OF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const bodySchema = z.object({
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
    .array(z.string())
    .transform(ids => [...new Set(ids)])
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
  ids: `ids must be an array of 1 to ${SIGNUP_VERDICTS_MAX_IDS} user ids.`,
};

/**
 * The signup chart's verdict for a page of the Users list: POST /api/admin/users/signup-verdicts.
 * Read-only; POST only so a full page of ids travels in the JSON body rather than the URL.
 * Separate from the list so classifying the range never slows or fails the list itself.
 */
export default adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: MODERATION_PAGE_READ },
})
  // Lower than the list's limit: each miss classifies the whole range (see classifyCohort).
  .use(rateLimit({ limit: 30, windowMs: 60_000, bucket: 'admin-users-signup-verdicts' }))
  .post(async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'ids');
      return res.status(400).json({ message: FIELD_MESSAGES[field] ?? FIELD_MESSAGES.ids });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    const { range, tzOffset, asOf, ids } = parsed.data;
    return res.json(await getSignupVerdicts({ range, tzOffsetMinutes: tzOffset, userIds: ids }, asOf));
  });

export const config = { api: { externalResolver: true } };
