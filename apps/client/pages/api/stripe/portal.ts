import { Organization, organizationRepository, User, userRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { verifyOrgPermission } from '@bike4mind/server-utils/utils/orgAccess';
import { SubscriptionOwnerType, SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { resolveSubscriptionSource } from '@bike4mind/server-utils/services/organizationService';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { createCustomer, CustomerType, stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { isAllowedCallbackOrigin } from '@server/integrations/stripe/callbackUrl';
import { signupNetworkMetadata } from '@server/integrations/stripe/riskMetadata';
import { z } from 'zod';

const stripePortalSchema = z.object({
  callbackUrl: z.string().url(),
  ownerType: z.enum(SubscriptionOwnerType),
  ownerId: z.string(),
});

const handler = baseApi()
  .use(requireStripeWebhook())
  .post(async (req, res) => {
    const authUser = req.user;
    const { callbackUrl, ownerType, ownerId } = stripePortalSchema.parse(req.body);

    if (!isAllowedCallbackOrigin(callbackUrl)) {
      throw new BadRequestError('callbackUrl must point to the deployed application origin');
    }

    if (!authUser.email) throw new BadRequestError('User email is required to access the billing portal');

    let customerId: string;

    if (ownerType === SubscriptionOwnerType.Organization) {
      const organization = await verifyOrgPermission(authUser, ownerId, 'manageBilling');

      // Block free/admin-granted orgs from auto-creating a Stripe customer here.
      // An admin must explicitly run the convert-to-paid flow to enable billing.
      const activeSubs = await subscriptionRepository.findActiveSubscriptionsByOwner(
        SubscriptionOwnerType.Organization,
        organization.id
      );
      const hasAdminGrant = activeSubs.some(s => resolveSubscriptionSource(s) === SubscriptionSource.AdminGrant);
      if (hasAdminGrant) {
        throw new ForbiddenError('Contact support to enable billing for this organization.');
      }

      if (!organization.stripeCustomerId) {
        const stripeCustomer = await createCustomer({
          email: organization.billingContact,
          name: organization.name,
          type: CustomerType.Organization,
        });
        // Only persist if stripeCustomerId is still null. Concurrent portal
        // requests would otherwise each create a Stripe customer and the
        // loser's persist would orphan the winner's record.
        const won = await Organization.findOneAndUpdate(
          { _id: organization.id, stripeCustomerId: null },
          { $set: { stripeCustomerId: stripeCustomer.id } },
          { new: true }
        );
        if (won) {
          organization.stripeCustomerId = stripeCustomer.id;
        } else {
          const fresh = await organizationRepository.findById(organization.id);
          if (!fresh?.stripeCustomerId) {
            throw new BadRequestError('Failed to attach Stripe customer to organization');
          }
          organization.stripeCustomerId = fresh.stripeCustomerId;
        }
      }

      customerId = organization.stripeCustomerId;
    } else {
      // Only the caller's own customer; another user's id answers like a missing one.
      if (ownerId !== authUser.id || !isValidObjectId(ownerId)) throw new NotFoundError('User not found');
      const user = await userRepository.findById(ownerId);
      if (!user) throw new NotFoundError('User not found');

      // Mirror the org-path guard: admin-granted user subscriptions must not
      // silently bootstrap a Stripe customer here; conversion to paid is an explicit admin action.
      const activeUserSubs = await subscriptionRepository.findActiveSubscriptionsByOwner(
        SubscriptionOwnerType.User,
        user.id
      );
      const hasAdminGrant = activeUserSubs.some(s => resolveSubscriptionSource(s) === SubscriptionSource.AdminGrant);
      if (hasAdminGrant) {
        throw new ForbiddenError('Contact support to enable billing for this account.');
      }

      if (!user.stripeCustomerId) {
        const stripeCustomer = await createCustomer({
          email: user.email!,
          name: user.name,
          type: CustomerType.User,
          metadata: signupNetworkMetadata(user),
        });
        // Conditional update - same race-protection as the org path above.
        const won = await User.findOneAndUpdate(
          { _id: user.id, stripeCustomerId: null },
          { $set: { stripeCustomerId: stripeCustomer.id } },
          { new: true }
        );
        if (won) {
          user.stripeCustomerId = stripeCustomer.id;
        } else {
          const fresh = await userRepository.findById(user.id);
          if (!fresh?.stripeCustomerId) {
            throw new BadRequestError('Failed to attach Stripe customer to user');
          }
          user.stripeCustomerId = fresh.stripeCustomerId;
        }
      }

      customerId = user.stripeCustomerId;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: callbackUrl,
    });

    return res.status(200).json({ url: session.url });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
