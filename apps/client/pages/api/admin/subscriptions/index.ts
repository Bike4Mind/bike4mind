import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import {
  ADMIN_SUBSCRIPTIONS_LIST_MAX,
  AdminSubscriptionsQuerySchema,
} from '@client/app/utils/adminSubscriptionsFilter';
import { listAdminSubscriptions } from '@server/admin/subscriptionsList/listAdminSubscriptions';
import qs from 'qs';

/**
 * The admin subscriptions list: GET /api/admin/subscriptions. User- and organization-owned rows, filtered,
 * sorted and paged on the server. The free-text search rides in the query string here but never in the
 * page URL, since it often holds an email.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 120, windowMs: 60_000, bucket: 'admin-subscriptions-list' }))
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const parsed = AdminSubscriptionsQuerySchema.safeParse(
        qs.parse(req.query as Record<string, string>, { arrayLimit: ADMIN_SUBSCRIPTIONS_LIST_MAX })
      );
      if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid query parameters', error: parsed.error.issues });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(await listAdminSubscriptions(parsed.data));
    })
  );

export default handler;
