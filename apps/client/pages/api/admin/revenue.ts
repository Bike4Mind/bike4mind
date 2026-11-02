import { ApiKeyScope } from '@bike4mind/common';
import { isStripeConfigured } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { AdminRevenueQuerySchema, type AdminRevenueResponse } from '@client/app/utils/adminRevenue';
import { adminRevenue } from '@server/admin/revenue/adminRevenue';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';

const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-revenue' }))
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const parsed = AdminRevenueQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid query parameters', error: parsed.error.issues });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      const body: AdminRevenueResponse = isStripeConfigured()
        ? await adminRevenue(parsed.data.range)
        : { stripeConfigured: false };
      return res.json(body);
    })
  );

export default handler;
