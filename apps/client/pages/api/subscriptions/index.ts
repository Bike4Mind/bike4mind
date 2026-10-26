import { hasAdminPermission } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { subscriptionRepository } from '@server/models/Subscription';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';

const handler = adminApi({ adminPermissions: { GET: 'support:read' } }).get(async (req, res) => {
  if (!hasAdminPermission(req.user, 'support:read')) {
    return res.status(403).json({ message: 'Unauthorized. Admin access required.' });
  }

  const search = req.query.search as string | undefined;
  const page = parseInt((req.query.page as string) || '1', 10);
  const limit = parseInt((req.query.limit as string) || '10', 10);

  // Filter to User subscriptions only - organization subscriptions handled separately
  const result = await subscriptionRepository.findWithOwnerDetails(search, page, limit, SubscriptionOwnerType.User);

  return res.json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
