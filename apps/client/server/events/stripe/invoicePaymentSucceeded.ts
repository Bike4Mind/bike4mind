import { StripeSubscriptionMetadataSchema } from '@client/lib/subscriptions/schema';
import { SubscriptionMetadata, SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import {
  handleUserSubscriptionInvoice,
  handleOrganizationSubscriptionInvoice,
} from '@client/lib/userSubscriptions/serverUtils';
import { StripeEvents } from '@server/utils/eventBus';
import { stripe } from '@server/integrations/stripe/stripe';
import { Config } from '@server/utils/config';
import { emitMetric } from '@server/utils/cloudwatch';
import { withEventContext } from '../utils';

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
});
