import { hasAdminPermission } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { subscriptionRepository } from '@server/models/Subscription';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';

const handler = adminApi({ adminPermissions: { GET: 'support:read' } }).get(async (req, res) => {
  if (!hasAdminPermission(req.user, 'support:read')) {
    return res.status(403).json({ message: 'Unauthorized. Admin access required.' });
  }

  // User subscriptions only - organization subscriptions have separate stats
  const stats = await subscriptionRepository.getSubscriptionStats(SubscriptionOwnerType.User);

  return res.json(stats);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
