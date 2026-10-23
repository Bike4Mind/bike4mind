import { userRepository } from '@bike4mind/database';
import { CreditPurchaseEvents } from '@bike4mind/common';
import { transactionSchema } from '@client/lib/credits/schemas';
import { PaymentDetails, TransactionType } from '@client/lib/credits/types';
import { handlePackageTransaction, handlePerCreditTransaction } from '@client/lib/credits/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { Config } from '@bike4mind/server-utils/utils/config';
import { BadRequestError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { createCustomer, CustomerType, stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { logEventSafe } from '@server/utils/analyticsLog';
import type Stripe from 'stripe';

const handler = baseApi()
  .use(requireStripeWebhook())
  .post(async (req, res) => {
    const parsedBody = transactionSchema.parse(req.body);

    // Credit purchases are pay-as-you-go and do not require an active subscription.
    // We still block accounts with an open payment dispute (mirrors the API-key auth
    // guard) so a flagged chargeback fraudster cannot keep buying credits.
    if (req.user.disputePending) {
      throw new ForbiddenError('Account suspended pending dispute resolution. Please contact support.');
    }

    const metadata: PaymentDetails['metadata'] = {
      userId: req.user.id,
      environment: Config.STAGE,
      transactionType: parsedBody.transactionType,
    };

    let paymentDetails: PaymentDetails;
    switch (parsedBody.transactionType) {
      case TransactionType.PerCredit:
        paymentDetails = await handlePerCreditTransaction(parsedBody, { userId: req.user.id, logger: req.logger });
        break;
      case TransactionType.Package:
        paymentDetails = await handlePackageTransaction(parsedBody);
        break;
      default:
        throw new BadRequestError('Invalid transaction type');
    }

    // The intent must carry a customer: the webhook resolves the purchaser by it, and the dispute
    // fallback and billing portal depend on it too. A customer created here is only persisted once
    // an intent references it, and is deleted if the intent cannot be created, so a failed start
    // never leaves a customer behind.
    let customerId = req.user.stripeCustomerId ?? undefined;
    let createdCustomerId: string | undefined;
    if (!customerId) {
      const customer = await createCustomer({
        email: req.user.email!,
        name: req.user.name!,
        type: CustomerType.User,
      });
      customerId = createdCustomerId = customer.id;
    }

    let paymentIntent: Stripe.PaymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: paymentDetails.amount,
        currency: 'usd',
        receipt_email: req.user.email ?? undefined,
        customer: customerId,
        description: paymentDetails.description,
        metadata: {
          ...metadata,
          ...paymentDetails.metadata,
        },
        automatic_payment_methods: {
          enabled: true,
        },
      });
    } catch (error) {
      if (createdCustomerId) {
        await stripe.customers.del(createdCustomerId).catch((delError: unknown) => {
          req.logger.error('[CreditPurchase] Failed to delete customer after intent creation failed', {
            userId: req.user.id,
            error: delError instanceof Error ? delError.message : String(delError),
          });
        });
      }
      throw error;
    }

    if (createdCustomerId) {
      req.user.stripeCustomerId = createdCustomerId;
      await userRepository.update({ id: req.user.id, stripeCustomerId: createdCustomerId });
    }

    const credits = Number(paymentDetails.metadata.credits);
    req.logger.info('[CreditPurchase] Payment intent created', {
      step: 'intent_created',
      userId: req.user.id,
      paymentIntentId: paymentIntent.id,
      transactionType: parsedBody.transactionType,
      amount: paymentDetails.amount,
      credits,
    });
    await logEventSafe(
      {
        type: CreditPurchaseEvents.CHECKOUT_STARTED,
        userId: req.user.id,
        metadata: {
          paymentIntentId: paymentIntent.id,
          transactionType: parsedBody.transactionType,
          amount: paymentDetails.amount,
          credits,
          ...(paymentDetails.metadata.packageId && { packageId: String(paymentDetails.metadata.packageId) }),
        },
      },
      undefined,
      req.logger
    );

    return res.status(200).send({
      clientSecret: paymentIntent.client_secret,
      publishableKey: Config.STRIPE_PUBLISHABLE_KEY,
      paymentIntentId: paymentIntent.id,
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
