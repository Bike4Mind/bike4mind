import { analyticsCohortsQuerySchema } from '@client/app/utils/analyticsCohorts';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getAnalyticsCohorts } from '@server/analytics/analyticsCohorts';

// Beside overview.ts: the retention cohorts of the same page, over the same rollups.
export default adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } })
  .use(rateLimit({ limit: 30, windowMs: 60_000, bucket: 'admin-analytics-cohorts' }))
  .get(async (req, res) => {
    const parsed = analyticsCohortsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid cohorts query.' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(await getAnalyticsCohorts(parsed.data));
  });

export const config = { api: { externalResolver: true } };
