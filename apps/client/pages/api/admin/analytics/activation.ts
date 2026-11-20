import { activationFunnelQuerySchema } from '@client/app/utils/activationFunnel';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getActivationFunnel } from '@server/analytics/activationFunnelSummary';
import { AnalyticsOverviewQueryError } from '@server/analytics/analyticsOverview';

// Computed live from the same classifier as the Users drill-down, so it gets its own, tighter bucket.
export default adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } })
  .use(rateLimit({ limit: 20, windowMs: 60_000, bucket: 'admin-analytics-activation' }))
  .get(async (req, res) => {
    const parsed = activationFunnelQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid analytics query.' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      return res.json(await getActivationFunnel(parsed.data, new Date()));
    } catch (error) {
      if (error instanceof AnalyticsOverviewQueryError) return res.status(400).json({ message: error.message });
      throw error;
    }
  });

export const config = { api: { externalResolver: true } };
