import { acquisitionQuerySchema } from '@client/app/utils/acquisitionConversion';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getAcquisitionConversion } from '@server/analytics/acquisitionConversionSummary';
import { AnalyticsOverviewQueryError } from '@server/analytics/analyticsOverview';

// Reads every signup's payments live, like the activation funnel, so it gets its own tight bucket.
export default adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } })
  .use(rateLimit({ limit: 20, windowMs: 60_000, bucket: 'admin-analytics-acquisition' }))
  .get(async (req, res) => {
    const parsed = acquisitionQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid analytics query.' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      return res.json(await getAcquisitionConversion(parsed.data, new Date()));
    } catch (error) {
      if (error instanceof AnalyticsOverviewQueryError) return res.status(400).json({ message: error.message });
      throw error;
    }
  });

export const config = { api: { externalResolver: true } };
