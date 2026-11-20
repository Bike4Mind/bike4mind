import { ApiKeyScope, CREDITS_PAGE_READ } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { getAdminSubscriptionDetail } from '@server/admin/subscriptionDetail/getAdminSubscriptionDetail';

/** One subscription's detail page payload: GET /api/admin/subscriptions/[id], where `id` is the Mongo id. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: CREDITS_PAGE_READ },
}).get(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const detail = await getAdminSubscriptionDetail(req.query.id);
    if (!detail) throw new NotFoundError('Subscription not found');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(detail);
  })
);

export default handler;
