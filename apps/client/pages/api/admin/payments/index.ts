import { ApiKeyScope } from '@bike4mind/common';
import {
  AdminPaymentsQuerySchema,
  type AdminPaymentsListResponse,
} from '@bike4mind/server-utils/app/utils/adminPayments';
import { listAdminPayments } from '@server/admin/payments/adminPayments';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';

/**
 * GET /api/admin/payments?from&to&kind&status&ownerType&currency&minAmount&maxAmount&search&page&limit
 *
 * Read-only. One page of credit purchases and subscription payments, newest first. Same gate as Revenue.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(rateLimit({ limit: 120, windowMs: 60_000, bucket: 'admin-payments-list' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = AdminPaymentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid query parameters', error: parsed.error.issues });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json((await listAdminPayments(parsed.data)) satisfies AdminPaymentsListResponse);
    })
  );

export default handler;
