import { organizationRepository } from '@bike4mind/database/infra';
import { BadRequestError } from '@bike4mind/utils';
import { ISubscription, SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { baseApi } from '@server/middlewares/baseApi';
import { subscriptionRepository } from '@server/models/Subscription';

const handler = baseApi().get(async (req, res) => {
  const { ownerType, ownerId } = req.query;

  let subscriptions: ISubscription[] = [];

  switch (ownerType) {
    case SubscriptionOwnerType.Organization: {
      const organization = await organizationRepository.findById(ownerId as string);
      if (!organization) {
        throw new BadRequestError('Organization not found');
      }

      subscriptions = await subscriptionRepository.findActiveSubscriptionsByOwner(
        SubscriptionOwnerType.Organization,
        organization.id
      );
      break;
    }
    case SubscriptionOwnerType.User:
      throw new BadRequestError('Not yet implemented');
    default:
      throw new BadRequestError('Invalid owner type');
  }

  return res.json(subscriptions);
});

export default handler;
