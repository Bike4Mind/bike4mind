import { analyticsOverviewQuerySchema } from '@client/app/utils/analyticsOverview';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { AnalyticsOverviewQueryError, getAnalyticsOverview } from '@server/analytics/analyticsOverview';

// Sits beside pages/api/admin/analytics.ts (the Models page feed); the two routes do not collide.
export default adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } })
  .use(rateLimit({ limit: 30, windowMs: 60_000, bucket: 'admin-analytics-overview' }))
  .get(async (req, res) => {
    const parsed = analyticsOverviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid analytics query.' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      return res.json(await getAnalyticsOverview(parsed.data));
    } catch (error) {
      if (error instanceof AnalyticsOverviewQueryError) return res.status(400).json({ message: error.message });
      throw error;
    }
  });

export const config = { api: { externalResolver: true } };
