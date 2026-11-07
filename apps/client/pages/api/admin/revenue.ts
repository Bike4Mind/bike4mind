import { ApiKeyScope } from '@bike4mind/common';
import { isStripeConfigured } from '@bike4mind/server-utils/integrations/stripe/stripe';
import {
  AdminRevenueQuerySchema,
  type AdminRevenueResponse,
  type AdminRevenueTrendResponse,
} from '@client/app/utils/adminRevenue';
import { adminRevenue, adminRevenueTrend } from '@server/admin/revenue/adminRevenue';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@server/middlewares/rateLimit';

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-revenue' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = AdminRevenueQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid query parameters', error: parsed.error.issues });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      if (!isStripeConfigured()) return res.json({ stripeConfigured: false } satisfies AdminRevenueResponse);
      if (parsed.data.part === 'trend') {
        return res.json({
          stripeConfigured: true,
          trend: await adminRevenueTrend(),
        } satisfies AdminRevenueTrendResponse);
      }
      return res.json((await adminRevenue(parsed.data.range)) satisfies AdminRevenueResponse);
    })
  );

export default handler;
