import { ApiKeyScope, CREDITS_PAGE_READ } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { getAdminSubscriptionHistory } from '@server/admin/subscriptionDetail/getAdminSubscriptionHistory';

/** The detail page's chart history (credit cycles, seat changes): GET /api/admin/subscriptions/[id]/history. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: CREDITS_PAGE_READ },
}).get(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const history = await getAdminSubscriptionHistory(req.query.id);
    if (!history) throw new NotFoundError('Subscription not found');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(history);
  })
);

export default handler;
