import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import {
  ADMIN_SUBSCRIPTIONS_LIST_MAX,
  AdminSubscriptionsFilterSchema,
} from '@client/app/utils/adminSubscriptionsFilter';
import { adminSubscriptionsSummary } from '@server/admin/subscriptionsList/listAdminSubscriptions';
import qs from 'qs';

/** Totals for the subscriptions list header and its built-in view tabs, scoped to the current filters. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-subscriptions-summary' }))
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const parsed = AdminSubscriptionsFilterSchema.safeParse(
        qs.parse(req.query as Record<string, string>, { arrayLimit: ADMIN_SUBSCRIPTIONS_LIST_MAX })
      );
      if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid query parameters', error: parsed.error.issues });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(await adminSubscriptionsSummary(parsed.data));
    })
  );

export default handler;
