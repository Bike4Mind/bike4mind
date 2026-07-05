import { Organization, organizationRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { createCustomer, CustomerType, stripe } from '@server/integrations/stripe/stripe';
import { isAllowedCallbackOrigin } from '@server/integrations/stripe/callbackUrl';
import { Config } from '@server/utils/config';
import {
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
} from '@client/lib/subscriptions/constants';
import { StripeSubscriptionMetadataSchema } from '@client/lib/subscriptions/schema';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { resolveSubscriptionSource } from '@server/services/organizationService';
import { z } from 'zod';

const ConvertSchema = z.object({
  callbackUrl: z.string().url(),
});

interface RequestQuery {
  id: string;
}

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as RequestQuery;
    if (!id) throw new BadRequestError('Organization id required');

    const { callbackUrl } = ConvertSchema.parse(req.body);

    if (!isAllowedCallbackOrigin(callbackUrl)) {
      throw new BadRequestError('callbackUrl must point to the deployed application origin');
    }

    const organization = await organizationRepository.findById(id);
    if (!organization) throw new NotFoundError('Organization not found');

    const activeSubs = await subscriptionRepository.findActiveSubscriptionsByOwner(
      SubscriptionOwnerType.Organization,
      organization.id
    );
    const adminGrant = activeSubs.find(s => resolveSubscriptionSource(s) === SubscriptionSource.AdminGrant);
    if (!adminGrant) {
      throw new BadRequestError('Organization has no active admin grant to convert');
    }

    if (organization.seats < ORGANIZATION_SUBSCRIPTION_MIN_SEATS) {
      throw new BadRequestError(
        `Org has ${organization.seats} seats; Stripe minimum is ${ORGANIZATION_SUBSCRIPTION_MIN_SEATS}. Adjust seats up before converting.`
      );
    }

    if (!organization.stripeCustomerId) {
      const customer = await createCustomer({
        email: organization.billingContact,
        name: organization.name,
        type: CustomerType.Organization,
      });
      // Conditional update so concurrent admin clicks don't each persist a
      // different stripeCustomerId (the loser's customer would be orphaned
      // in Stripe with no DB pointer). The filter `stripeCustomerId: null`
      // matches both null and missing in MongoDB, so only the first writer
      // succeeds; the loser falls through to the reload below.
      const won = await Organization.findOneAndUpdate(
        { _id: organization.id, stripeCustomerId: null },
        { $set: { stripeCustomerId: customer.id } },
        { new: true }
      );
      if (won) {
        organization.stripeCustomerId = customer.id;
      } else {
        const fresh = await organizationRepository.findById(organization.id);
        if (!fresh?.stripeCustomerId) {
          throw new BadRequestError('Failed to attach Stripe customer to organization');
        }
        organization.stripeCustomerId = fresh.stripeCustomerId;
      }
    }

    const metadata = StripeSubscriptionMetadataSchema.parse({
      userId: organization.userId,
      stage: Config.STAGE,
      ownerType: SubscriptionOwnerType.Organization,
      organizationId: organization.id,
    });

    // Lock the checkout quantity to the granted seat count. If the admin
    // wants a different count, they should `PATCH /seats` BEFORE generating
    // the conversion URL. Allowing the customer to adjust at checkout opens
    // a race: an admin seat change or revoke can land between session create
    // and checkout completion, and the webhook would then apply whatever
    // Stripe accepted - bypassing our org-internal floor.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: organization.stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
          quantity: organization.seats,
          // adjustable_quantity intentionally omitted (defaults to disabled).
          // ORGANIZATION_SUBSCRIPTION_MAX_SEATS is enforced at admin endpoint
          // boundaries; the convert endpoint above already gates seats >= MIN.
        },
      ],
      success_url: `${callbackUrl}${callbackUrl.includes('?') ? '&' : '?'}subscription_success=true`,
      cancel_url: callbackUrl,
      subscription_data: { metadata },
    });

    await logAuditEvent(
      {
        userId: organization.userId,
        action: AdminOrgAuditEvents.ORG_CONVERT_INITIATED,
        adminUserId: req.user!.id,
        adminUsername: req.user!.username,
        metadata: {
          organizationId: organization.id,
          seats: organization.seats,
          stripeCustomerId: organization.stripeCustomerId,
          checkoutSessionId: session.id,
        },
      },
      req.logger
    );

    return res.status(200).json({ checkoutUrl: session.url });
  })
);

export default handler;
