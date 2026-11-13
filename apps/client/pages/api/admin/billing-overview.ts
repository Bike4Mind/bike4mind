import { ApiKeyScope, CREDITS_PAGE_READ } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { respond } from '@server/utils/respond';
import { loadBillingOverview } from '@server/admin/billingOverview/loadBillingOverview';
import { BillingOverviewQuerySchema, BillingOverviewSchema } from '@client/app/utils/adminBillingOverview';

/**
 * GET /api/admin/billing-overview?ownerType=user|organization&ownerId=...&range=30d|90d|365d
 *
 * One owner's read-only billing summary: subscription standing, balance by funding source, payments,
 * usage attribution and a combined activity list. Gated like the other credit reads (CREDITS_PAGE_READ).
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: CREDITS_PAGE_READ },
})
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-billing-overview' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = BillingOverviewQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid query parameters', error: parsed.error.issues });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return respond(res, BillingOverviewSchema, await loadBillingOverview(parsed.data, req.logger));
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
