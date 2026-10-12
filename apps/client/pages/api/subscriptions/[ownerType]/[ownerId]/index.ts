import type { IUserDocument } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ISubscription, SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { baseApi } from '@server/middlewares/baseApi';
import { verifyOrgAccess, verifyOrgMembership } from '@server/utils/orgAccess';
import { subscriptionRepository } from '@server/models/Subscription';

async function resolveSubscriptionOrganization(user: IUserDocument, organizationId: string) {
  try {
    return await verifyOrgMembership(user, organizationId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    // Managers without a membership row can view the Team, including its plan status.
    // Keep the membership path first so ordinary members retain access.
    return verifyOrgAccess(user, organizationId);
  }
}

const handler = baseApi().get(async (req, res) => {
  const { ownerType, ownerId } = req.query;

  let subscriptions: ISubscription[] = [];

  switch (ownerType) {
    case SubscriptionOwnerType.Organization: {
      // Both members and appointed managers can see the Team's plan in its list and detail views.
      // The caller-supplied ownerId must pass one of those scoped read gates.
      const organization = await resolveSubscriptionOrganization(req.user, ownerId as string);

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
