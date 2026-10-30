import { analyticsOverviewQuerySchema } from '@client/app/utils/analyticsOverview';
import { baseApi } from '@server/middlewares/baseApi';
import { AnalyticsOverviewQueryError, getAnalyticsOverview } from '@server/analytics/analyticsOverview';

// Sits beside pages/api/admin/analytics.ts (the Models page feed); the two routes do not collide.
export default baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  if (!req.user?.isAdmin) return res.status(403).json({ message: 'Admin access required' });
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
