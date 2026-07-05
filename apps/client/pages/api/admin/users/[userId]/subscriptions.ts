import { organizationRepository, userRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { IOrganizationDocument } from '@bike4mind/common';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { SUBSCRIPTION_PLANS_MAP } from '@client/lib/userSubscriptions/constants';
import { ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT } from '@client/lib/subscriptions/constants';
import { subscriptionRepository } from '@server/models/Subscription';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    // Check admin authorization
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { userId } = req.query as { userId: string };

    if (typeof userId !== 'string') {
      throw new BadRequestError('Invalid user ID');
    }

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Get individual subscriptions
    const individualSubscriptions = await subscriptionRepository.findActiveUserSubscriptions(userId);

    // Enhance individual subscriptions with plan details
    const enhancedIndividualSubscriptions = individualSubscriptions.map(sub => {
      const planDetail = SUBSCRIPTION_PLANS_MAP[sub.priceId];
      const defaultCredits = planDetail?.credits || 0;
      const effectiveCredits = sub.customCreditsPerCycle ?? defaultCredits;

      // Repository returns plain objects via .lean({ virtuals: true })
      return {
        ...sub,
        planName: planDetail?.name,
        planCredits: planDetail?.credits,
        customCreditsPerCycle: sub.customCreditsPerCycle,
        effectiveCreditsPerCycle: effectiveCredits,
      };
    });

    // Get organizations where the user is either owner or member
    const { data: userOrganizations } = await organizationRepository.search(
      '', // no search query
      { userId }, // filter by userId (this includes both owner and member)
      { page: 1, limit: 100 }, // get first 100 organizations
      { field: 'name', direction: 'asc' }
    );

    const teamSubscriptionsPromises = userOrganizations.map(async (org: IOrganizationDocument) => {
      // Find active subscription for this organization
      const subscriptions = await subscriptionRepository.findActiveSubscriptionsByOwner(
        SubscriptionOwnerType.Organization,
        org.id
      );

      if (subscriptions.length > 0) {
        const sub = subscriptions[0]; // Take the first active subscription
        const defaultCredits = sub.quantity * ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT;
        const effectiveCredits = sub.customCreditsPerCycle ?? defaultCredits;

        // Repository returns plain objects via .lean({ virtuals: true })
        return {
          organization: {
            id: org.id,
            name: org.name,
            seats: org.seats,
            currentCredits: org.currentCredits,
            users: org.users || [],
          },
          subscription: {
            ...sub,
            effectiveCreditsPerCycle: effectiveCredits,
            defaultCreditsPerCycle: defaultCredits,
          },
        };
      }
      return null;
    });

    const teamSubscriptionsResults = await Promise.all(teamSubscriptionsPromises);
    const teamSubscriptions = teamSubscriptionsResults.filter(
      (result): result is NonNullable<typeof result> => result !== null
    );

    return res.status(200).json({
      individualSubscriptions: enhancedIndividualSubscriptions,
      teamSubscriptions,
      userCredits: user.currentCredits,
    });
  })
);

export default handler;
