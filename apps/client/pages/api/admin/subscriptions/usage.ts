import { ApiKeyScope, CREDITS_PAGE_READ } from '@bike4mind/common';
import { SubscriptionUsageQuerySchema } from '@bike4mind/server-utils/app/utils/subscriptionUsage';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { subscriptionUsageDetail } from '@server/admin/subscriptionsList/subscriptionUsage';

export default adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: CREDITS_PAGE_READ },
})
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-subscription-usage' }))
  .get(async (req, res) => {
    const parsed = SubscriptionUsageQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ message: 'Invalid subscription id' });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(await subscriptionUsageDetail(parsed.data.subscriptionId));
  });

export const config = { api: { externalResolver: true } };
