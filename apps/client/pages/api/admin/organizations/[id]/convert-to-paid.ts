import { Organization, organizationRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { createCustomer, CustomerType, stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { USD_CHECKOUT_SESSION_PARAMS } from '@server/integrations/stripe/checkoutCurrency';
import { firstPurchaseCardOptions } from '@server/integrations/stripe/threeDSecure';
import { isAllowedCallbackOrigin } from '@server/integrations/stripe/callbackUrl';
import { Config } from '@bike4mind/server-utils/utils/config';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID } from '@bike4mind/server-utils/lib/subscriptions/constants';
import { getTeamPlanSettings } from '@bike4mind/server-utils/services/teamPlanSettings';
import { StripeSubscriptionMetadataSchema } from '@bike4mind/server-utils/lib/subscriptions/schema';
import { SubscriptionOwnerType, SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { resolveSubscriptionSource } from '@server/services/organizationService';
import { z } from 'zod';

const ConvertSchema = z.object({
  callbackUrl: z.string().url(),
});

interface RequestQuery {
  id: string;
}

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as RequestQuery;
    if (!id) throw new BadRequestError('Organization id required');

    const { callbackUrl } = ConvertSchema.parse(req.body);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

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

    const { minSeats } = await getTeamPlanSettings();
    if (organization.seats < minSeats) {
      throw new BadRequestError(
        `Org has ${organization.seats} seats; Stripe minimum is ${minSeats}. Adjust seats up before converting.`
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
    const threeDSecureOptions = await firstPurchaseCardOptions(
      { stripeCustomerId: organization.stripeCustomerId, accountCreatedAt: organization.createdAt },
      req.logger
    );

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      ...USD_CHECKOUT_SESSION_PARAMS,
      customer: organization.stripeCustomerId,
      payment_method_types: ['card'],
      ...threeDSecureOptions,
      line_items: [
        {
          price: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
          quantity: organization.seats,
          // adjustable_quantity intentionally omitted (defaults to disabled).
          // The teamPlanMaxSeats ceiling is enforced at admin endpoint
          // boundaries; the convert endpoint above already gates seats >= MIN.
        },
      ],
      success_url: `${callbackUrl}${callbackUrl.includes('?') ? '&' : '?'}subscription_success=true`,
      cancel_url: callbackUrl,
      subscription_data: { metadata },
    });

    await recordAdminActionFromRequest(req, {
      action: 'org.conversion.initiated',
      target: { kind: 'organization', id: organization.id, displayName: organization.name },
      summary: 'initiated conversion to a paid subscription',
      reason,
      details: {
        seats: organization.seats,
        stripeCustomerId: organization.stripeCustomerId,
        checkoutSessionId: session.id,
        ownerId: organization.userId,
      },
    });

    return res.status(200).json({ checkoutUrl: session.url });
  })
);

export default handler;
