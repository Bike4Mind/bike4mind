import { userRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { subscriptionPlanSchema } from '@client/lib/userSubscriptions/schemas';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { subscriptionRepository } from '@server/models/Subscription';
import { Config } from '@server/utils/config';
import { createCustomer, CustomerType, stripe } from '@server/integrations/stripe/stripe';
import { isAllowedCallbackOrigin } from '@server/integrations/stripe/callbackUrl';
import { Request } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';

type RequestBody = z.infer<typeof subscriptionPlanSchema>;

const handler = baseApi()
  .use(requireStripeWebhook())
  .post<Request<unknown, RequestBody>>(async (req, res) => {
    const { priceId, callbackUrl } = subscriptionPlanSchema.parse(req.body);

    // Restrict the Stripe success/cancel redirect to the deployed app origin - an
    // external callbackUrl is an open-redirect/phishing vector off Stripe's hosted
    // checkout page (mirrors pages/api/stripe/portal.ts).
    if (!isAllowedCallbackOrigin(callbackUrl)) {
      throw new BadRequestError('callbackUrl must point to the deployed application origin');
    }

    const planSubscription = await subscriptionRepository.findUserSubscriptionByPriceId(priceId, req.user.id);
    if (planSubscription) {
      throw new BadRequestError('User is already subscribed to this plan');
    }

    if (!req.user.stripeCustomerId) {
      const customer = await createCustomer({
        email: req.user.email!,
        name: req.user.name!,
        type: CustomerType.User,
      });
      req.user.stripeCustomerId = customer.id;
      await userRepository.update(req.user);
    } else {
      // Recreate the customer if missing from Stripe (we recently switched Stripe accounts).
      try {
        await stripe.customers.retrieve(req.user.stripeCustomerId);
      } catch (error) {
        if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
          const customer = await createCustomer({
            email: req.user.email!,
            name: req.user.name!,
            type: CustomerType.User,
          });
          req.user.stripeCustomerId = customer.id;
          await userRepository.update(req.user);
        } else {
          throw error;
        }
      }
    }

    try {
      await stripe.prices.retrieve(priceId);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
        throw new BadRequestError('Plan does not exist');
      } else {
        throw error;
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      customer: req.user.stripeCustomerId,
      success_url: callbackUrl,
      cancel_url: callbackUrl,
      subscription_data: {
        metadata: {
          userId: req.user.id,
          stage: Config.STAGE,
          ownerType: 'User', // Identifies this as a user subscription (vs organization)
        },
      },
    });

    return res.status(200).send({ sessionUrl: session.url });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
