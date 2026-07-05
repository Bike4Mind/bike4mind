import { baseApi } from '@server/middlewares/baseApi';
import { subscriptionRepository } from '@server/models/Subscription';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';

const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
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
