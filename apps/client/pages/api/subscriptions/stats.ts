import { CREDITS_PAGE_READ } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';

const handler = adminApi({ adminPermissions: { GET: CREDITS_PAGE_READ } }).get(async (req, res) => {
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
