import { BadRequestError } from '@bike4mind/utils';
import { ISubscription, SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { baseApi } from '@server/middlewares/baseApi';
import { verifyOrgMembership } from '@server/utils/orgAccess';
import { subscriptionRepository } from '@server/models/Subscription';

const handler = baseApi().get(async (req, res) => {
  const { ownerType, ownerId } = req.query;

  let subscriptions: ISubscription[] = [];

  switch (ownerType) {
    case SubscriptionOwnerType.Organization: {
      // Membership, not management: the org list and the org detail header fetch this for every
      // member, so an owner/manager gate would blank the plan on a screen plain members use. The
      // caller-supplied ownerId was previously looked up with a bare findById, which handed any
      // authenticated user any organization's active subscriptions. verifyOrgMembership answers
      // NotFoundError identically for a missing org and one the caller does not belong to.
      const organization = await verifyOrgMembership(req.user, ownerId as string);

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
