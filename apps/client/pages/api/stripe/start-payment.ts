import { userRepository } from '@bike4mind/database';
import { transactionSchema } from '@client/lib/credits/schemas';
import { PaymentDetails, TransactionType } from '@client/lib/credits/types';
import { handlePackageTransaction, handlePerCreditTransaction } from '@client/lib/credits/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { Config } from '@server/utils/config';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { createCustomer, CustomerType, stripe } from '@server/integrations/stripe/stripe';

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

    const stripeApi = stripe;
    if (!req.user.stripeCustomerId) {
      const customer = await createCustomer({
        email: req.user.email!,
        name: req.user.name!,
        type: CustomerType.User,
      });
      req.user.stripeCustomerId = customer.id;
      await userRepository.update(req.user);
    }

    let paymentDetails: PaymentDetails;
    switch (parsedBody.transactionType) {
      case TransactionType.PerCredit:
        paymentDetails = await handlePerCreditTransaction(parsedBody);
        break;
      case TransactionType.Package:
        paymentDetails = await handlePackageTransaction(parsedBody);
        break;
      default:
        throw new BadRequestError('Invalid transaction type');
    }

    const paymentIntent = await stripeApi.paymentIntents.create({
      amount: paymentDetails.amount,
      currency: 'usd',
      receipt_email: req.user.email ?? undefined,
      customer: req.user.stripeCustomerId ?? undefined,
      description: paymentDetails.description,
      metadata: {
        ...metadata,
        ...paymentDetails.metadata,
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    return res
      .status(200)
      .send({ clientSecret: paymentIntent.client_secret, publishableKey: Config.STRIPE_PUBLISHABLE_KEY });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
