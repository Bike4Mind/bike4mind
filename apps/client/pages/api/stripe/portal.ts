import { Organization, organizationRepository, User, userRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { resolveSubscriptionSource } from '@server/services/organizationService';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { createCustomer, CustomerType, stripe } from '@server/integrations/stripe/stripe';
import { isAllowedCallbackOrigin } from '@server/integrations/stripe/callbackUrl';
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
      const organization = await organizationRepository.findById(ownerId);
      if (!organization) throw new BadRequestError('Organization not found');

      // TODO: Check for user's permission to access organization billing portal.
      // For now, only the organization owner can access the billing portal.
      if (organization.userId !== authUser.id)
        throw new BadRequestError('User is not authorized to access this organization');

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
      const user = await userRepository.findById(ownerId);
      if (!user) throw new BadRequestError('User not found');

      if (user.id !== authUser.id) throw new BadRequestError('User is not authorized to access this user');

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
