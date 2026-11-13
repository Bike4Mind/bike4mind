import { ApiKeyScope } from '@bike4mind/common';
import {
  AdminPaymentsFilterSchema,
  type AdminPaymentsSummaryResponse,
} from '@bike4mind/server-utils/app/utils/adminPayments';
import { adminPaymentsSummary } from '@server/admin/payments/adminPayments';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';

/**
 * GET /api/admin/payments/summary?<filters>
 *
 * Read-only. Gross, refunds, dispute losses and net per currency for the range and the previous range of
 * the same length, distinct payers, credit buyers and the gross series. Same gate as Revenue.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-payments-summary' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = AdminPaymentsFilterSchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid query parameters', error: parsed.error.issues });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json((await adminPaymentsSummary(parsed.data)) satisfies AdminPaymentsSummaryResponse);
    })
  );

export default handler;
