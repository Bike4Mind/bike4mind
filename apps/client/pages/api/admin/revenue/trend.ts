import { ApiKeyScope } from '@bike4mind/common';
import { isStripeConfigured } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import type { AdminRevenueTrendResponse } from '@client/app/utils/adminRevenue';
import { adminRevenueTrend } from '@server/admin/revenue/adminRevenue';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';

// Snapshot rows only, so the subscriptions list's sparklines skip the live totals GET /api/admin/revenue computes.
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-revenue-trend' }))
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      res.setHeader('Cache-Control', 'private, no-store');
      const body: AdminRevenueTrendResponse = isStripeConfigured()
        ? { stripeConfigured: true, trend: await adminRevenueTrend() }
        : { stripeConfigured: false };
      return res.json(body);
    })
  );

export default handler;
