import { organizationRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import {
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
} from '@client/lib/subscriptions/constants';
import { OrgSubscriptionSubscribeSchema, StripeSubscriptionMetadataSchema } from '@client/lib/subscriptions/schema';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { createCustomer, CustomerType, stripe } from '@server/integrations/stripe/stripe';
import { appendSuccessParams, isAllowedCallbackOrigin } from '@server/integrations/stripe/callbackUrl';
import { Request } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { subscriptionRepository } from '@server/models/Subscription';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';

const handler = baseApi()
  .use(requireStripeWebhook())
  .post<Request<{}, {}, z.infer<typeof OrgSubscriptionSubscribeSchema>>>(async (req, res) => {
    const { priceId, organizationId, quantity, organizationData, callbackUrl } = OrgSubscriptionSubscribeSchema.parse(
      req.body
    );

    if (priceId !== ORGANIZATION_SUBSCRIPTION_PRICE_ID) {
      throw new BadRequestError('Invalid Organization Subscription Price ID');
    }

    // Restrict the Stripe success/cancel redirect to the deployed app origin. An
    // external callbackUrl is an open-redirect/phishing vector off Stripe's hosted
    // checkout page, and this route's schema types callbackUrl as a bare string, so
    // this is the only guard. The individual path and pages/api/stripe/portal.ts
    // already do this; the omission here matters more now that the success redirect
    // carries the completed checkout session id.
    if (!isAllowedCallbackOrigin(callbackUrl)) {
      throw new BadRequestError('callbackUrl must point to the deployed application origin');
    }

    // Check for existing active subscription
    if (organizationId) {
      const existingSubscription = await subscriptionRepository.findByPriceIdAndOwner(
        priceId,
        SubscriptionOwnerType.Organization,
        organizationId
      );

      if (existingSubscription) {
        throw new BadRequestError('An active subscription already exists for this organization');
      }
    }

    let minSeats = ORGANIZATION_SUBSCRIPTION_MIN_SEATS;

    let customerId: string | undefined;
    let customer: undefined | Stripe.Customer;
    if (organizationId) {
      const organization = await organizationRepository.findById(organizationId);
      if (!organization) throw new NotFoundError('Organization not found');

      if (!organization.stripeCustomerId) {
        customer = await createCustomer({
          email: organization.billingContact,
          name: organization.name,
          type: CustomerType.Organization,
        });

        organization.stripeCustomerId = customer.id;

        await organizationRepository.update(organization);
      }

      minSeats = Math.max(ORGANIZATION_SUBSCRIPTION_MIN_SEATS, organization.users.length + 1);
      customerId = organization.stripeCustomerId;
    } else {
      customer = await createCustomer({
        email: req.user.email!,
        name: organizationData?.name ?? req.user.email!,
        type: CustomerType.Organization,
      });

      customerId = customer.id;
    }

    const metadata = StripeSubscriptionMetadataSchema.parse({
      userId: req.user.id,
      stage: Config.STAGE,
      ownerType: SubscriptionOwnerType.Organization,
      ...(organizationData
        ? { newOrganizationName: organizationData.name }
        : {
            organizationId: organizationId,
          }),
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: quantity,
          adjustable_quantity: {
            enabled: true,
            minimum: minSeats,
            maximum: ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
          },
        },
      ],
      // Carries the Stripe session id alongside the existing success marker so the
      // returning client can report revenue (see api/subscriptions/checkout-session.ts).
      success_url: appendSuccessParams(callbackUrl),
      cancel_url: callbackUrl,
      subscription_data: {
        metadata,
      },
    });

    return res.status(200).json({ sessionUrl: session.url });
  });

export default handler;
