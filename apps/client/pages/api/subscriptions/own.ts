import { baseApi } from '@server/middlewares/baseApi';
import { subscriptionRepository } from '@server/models/Subscription';
import { subscriptionsToUserSubscriptions } from '@client/lib/userSubscriptions/types';

const handler = baseApi().get(async (req, res) => {
  const userId = req.user?.id;

  // Returns all subscriptions (active, canceled, past), not just active ones - the
  // legacy endpoint's clients expect to see full subscription history.
  const subscriptions = await subscriptionRepository.findAllUserSubscriptions(userId);

  // Map to IUserSubscription format for backward compatibility
  const userSubscriptions = subscriptionsToUserSubscriptions(subscriptions);

  return res.json(userSubscriptions);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
