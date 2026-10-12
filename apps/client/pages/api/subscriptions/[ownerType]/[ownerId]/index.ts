import { BadRequestError } from '@bike4mind/utils';
import { ISubscription, SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { baseApi } from '@server/middlewares/baseApi';
import { verifyOrgMemberOrManager } from '@server/utils/orgAccess';
import { subscriptionRepository } from '@server/models/Subscription';

const handler = baseApi().get(async (req, res) => {
  const { ownerType, ownerId } = req.query;

  let subscriptions: ISubscription[] = [];

  switch (ownerType) {
    case SubscriptionOwnerType.Organization: {
      // Both members and appointed managers can see the Team's plan in its list and detail views.
      // The caller-supplied ownerId must pass one of those scoped read gates.
      const organization = await verifyOrgMemberOrManager(req.user, ownerId as string);

      // Non-terminal, not active-only: an org whose subscription is past_due must still
      // see it here, or the billing screen loses the Stripe portal - the only route to
      // fix the card or cancel. Entitlement checks read the active-only lookup instead.
      subscriptions = await subscriptionRepository.findNonTerminalSubscriptionsByOwner(
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
