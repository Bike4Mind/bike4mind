import { userRepository } from '@bike4mind/database';
import { StripeSubscriptionMetadataSchema } from '@bike4mind/server-utils/lib/subscriptions/schema';
import { SubscriptionMetadata, SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  handleUserSubscriptionInvoice,
  handleOrganizationSubscriptionInvoice,
} from '@workers/lib/userSubscriptions/serverUtils';
import { StripeEvents } from '@server/utils/eventBus';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { Config } from '@bike4mind/server-utils/utils/config';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { withEventContext } from '@workers/utils/eventContext';
import { postNewPaidSubscriptionToSlack } from '@server/integrations/slack/subscriptionLifecycle';
import { emitPurchaseEvents } from '@server/analytics/signupEvents';

export const handler = withEventContext(async (event, logger) => {
  const { invoiceId, subscriptionId } = StripeEvents.InvoicePaymentSucceeded.schema.parse(event.properties);

  // Expand payments so we can extract the payment intent ID
  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payments'] });
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Try to validate with Zod first for security
  let metadata: SubscriptionMetadata;
  const parseResult = StripeSubscriptionMetadataSchema.safeParse(subscription.metadata);

  if (parseResult.success) {
    metadata = parseResult.data as SubscriptionMetadata;
  } else {
    // Legacy subscription without proper metadata structure; treat as User for backward compatibility.
    logger.warn(
      `Legacy subscription metadata detected for ${subscription.id}. Validation errors:`,
      parseResult.error.issues
    );
    metadata = {
      userId: subscription.metadata.userId as string,
      stage: subscription.metadata.stage as string,
      ownerType: undefined,
      organizationId: subscription.metadata.organizationId as string,
    };
  }

  // Stage guard (symmetric with customerSubscriptionUpdated): a misrouted
  // cross-stage Stripe event (e.g. a test-mode invoice reaching production)
  // carries another environment's metadata.stage. This handler CREATES the
  // subscription record and ADDS CREDITS, so skipping a foreign-stage event is
  // even more important here than on the status-update path. Legacy subs with
  // no stage (metadata.stage absent) fall through unchanged.
  if (metadata.stage && metadata.stage !== Config.STAGE) {
    logger.warn(
      `Skipping invoice ${invoiceId}: metadata.stage '${metadata.stage}' does not match current stage '${Config.STAGE}'`
    );
    await emitMetric('Lumina5/Entitlements', 'EntitlementSkipped', 1, { reason: 'stage_mismatch' });
    return;
  }

  if (metadata.ownerType === SubscriptionOwnerType.Organization) {
    await handleOrganizationSubscriptionInvoice(invoice, subscription, metadata, logger);
  } else if (metadata.ownerType === SubscriptionOwnerType.User) {
    await handleUserSubscriptionInvoice(invoice, subscription, metadata, logger);
  } else {
    // Legacy subscription (pre-migration, missing ownerType) - treat as User.
    // Only 28 total subscriptions, so manual verification of Stripe metadata is feasible.
    logger.info(`Processing legacy subscription (missing ownerType): ${subscription.id}`);
    await handleUserSubscriptionInvoice(invoice, subscription, metadata, logger);
  }

  logger.info('Successfully processed invoice payment', {
    invoiceId,
    subscriptionId,
    ownerType: metadata.ownerType || 'User (legacy)',
  });

  // Announce first paid charges only. `subscription_create` is Stripe's own marker for
  // the invoice that opens a subscription; `subscription_cycle` is a renewal and
  // would post monthly per customer. A $0 opening invoice (a full-discount coupon;
  // checkout never sets a trial) is not a paid subscription. Placed after the work
  // above so the message means the subscription and credits actually landed.
  //
  // Awaited but non-throwing by construction: this handler retrying would re-run
  // credit granting, so a Slack outage must not be able to cause that.
  if (invoice.billing_reason === 'subscription_create' && invoice.amount_paid > 0) {
    await postNewPaidSubscriptionToSlack(invoice, subscription);
  }

  // An organization subscription belongs to the organization, not the user who started checkout.
  // That user's signup touches cannot attribute the organization's payments.
  // Legacy subscriptions without ownerType were handled as User above. Check the raw value too:
  // the compatibility parse can erase an invalid Organization ownerType.
  if (metadata.userId && (metadata.ownerType === SubscriptionOwnerType.User || !subscription.metadata.ownerType)) {
    let payer: Awaited<ReturnType<typeof userRepository.findById>> = null;
    try {
      payer = await userRepository.findById(metadata.userId);
    } catch (error) {
      logger.warn(`Purchase not reported to Overwatch: payer lookup failed for invoice ${invoiceId}`, {
        error,
      });
    }
    await emitPurchaseEvents({
      user: payer,
      paymentId: invoiceId,
      kind: 'subscription',
      amountMinor: invoice.amount_paid,
      currency: invoice.currency,
      billingReason: invoice.billing_reason,
    });
  }
});
