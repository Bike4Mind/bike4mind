import { ApiKeyScope } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { getAdminSubscriptionDetail } from '@server/admin/subscriptionDetail/getAdminSubscriptionDetail';

/** One subscription's detail page payload: GET /api/admin/subscriptions/[id], where `id` is the Mongo id. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
    const detail = await getAdminSubscriptionDetail(req.query.id);
    if (!detail) throw new NotFoundError('Subscription not found');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(detail);
  })
);

export default handler;
