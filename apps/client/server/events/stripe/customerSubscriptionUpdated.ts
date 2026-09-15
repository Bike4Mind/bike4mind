import { organizationRepository, withTransaction } from '@bike4mind/database';
import { entitlementsForPriceIds } from '@client/lib/entitlements/registry';
import { StripeSubscriptionMetadataSchema } from '@client/lib/subscriptions/schema';
import { SubscriptionMetadata, SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { setSeats } from '@server/services/organizationService';
import { Config } from '@server/utils/config';
import { emitMetric } from '@server/utils/cloudwatch';
import { StripeEvents } from '@server/utils/eventBus';
import { stripe } from '@server/integrations/stripe/stripe';
import { sendToClient } from '@server/websocket/utils';
import dayjs from 'dayjs';
import { Resource } from 'sst';
import { withEventContext } from '../utils';

export const handler = withEventContext(async (event, logger) => {
  const { subscriptionId } = StripeEvents.CustomerSubscriptionUpdated.schema.parse(event.properties);

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Validate metadata with safeParse to handle legacy subscriptions
  let metadata: SubscriptionMetadata;
  const parseResult = StripeSubscriptionMetadataSchema.safeParse(subscription.metadata);

  if (parseResult.success) {
    metadata = parseResult.data;
  } else {
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

  // Stage guard: Stripe webhooks are wired per-environment, but a misrouted
  // event (e.g. a test-mode event reaching production, or vice versa) carries
  // another stage's metadata. We set metadata.stage at checkout creation, so
  // a present-but-mismatched stage means this subscription does not belong to
  // this environment - skip it rather than mutating a row that isn't ours.
  // Legacy subs without a stage fall through unchanged.
  if (metadata.stage && metadata.stage !== Config.STAGE) {
    logger.warn(
      `Skipping subscription ${subscription.id}: metadata.stage '${metadata.stage}' does not match current stage '${Config.STAGE}'`
    );
    // Surface the skip for on-call - a cross-stage misroute would otherwise be
    // invisible beyond a log line (same metric/dimension as the other skips).
    await emitMetric('Lumina5/Entitlements', 'EntitlementSkipped', 1, { reason: 'stage_mismatch' });
    return;
  }

  // Update subscription in unified Subscription model
  const shouldInvalidateOrgs = await withTransaction(async () => {
    const [item] = subscription.items.data;
    const updatedSubscription = await subscriptionRepository.updateByStripeSubscriptionId(subscription.id, {
      status: subscription.status,
      periodStartsAt: dayjs.unix(item.current_period_start).toDate(),
      periodEndsAt: dayjs.unix(item.current_period_end).toDate(),
      canceledAt: subscription.canceled_at ? dayjs.unix(subscription.canceled_at).toDate() : null,
      priceId: item.price.id,
      quantity: item.quantity ?? 1,
    });

    if (metadata.ownerType === SubscriptionOwnerType.Organization) {
      // Keep organization.seats and the active Subscription.quantity in sync
      // with Stripe via the shared setSeats service (validation included).
      const organization = await organizationRepository.findByStripeCustomerId(subscription.customer as string);
      if (organization) {
        const newQuantity = item.quantity ?? 1;
        try {
          await setSeats(organization.id, newQuantity, { type: 'stripe' });
        } catch (err) {
          // Stripe is the source of truth for billed seat count. If our
          // local validation (team-size floor / platform min) would reject
          // this value, we still must NOT drift from Stripe - otherwise the
          // customer is billed for a different number of seats than our DB
          // reports. Log loudly and force-write the seat count directly.
          // The org-internal floor will re-apply on the next manual change.
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(
            `setSeats validation failed for org ${organization.id} on Stripe webhook (quantity=${newQuantity}). Force-syncing to avoid drift. Reason: ${message}`
          );
          organization.seats = newQuantity;
          await organizationRepository.update(organization);
        }
        return true;
      }
    }

    if (!updatedSubscription) {
      logger.warn(`Subscription not found: ${subscription.id}`);
      return false;
    }

    return false;
  });

  // sendToClient calls must be outside the transaction to avoid
  // Connection.find() inheriting a committed transaction session.
  // metadata.userId can be undefined on legacy metadata - sendToClient with a
  // falsy userId would Connection.find({}) and hit every connection.
  if (shouldInvalidateOrgs && metadata.userId) {
    sendToClient(metadata.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['organizations'],
    });
  }

  logger.info(`Updated subscription status to ${subscription.status}`);
  if (metadata.userId) {
    sendToClient(metadata.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['subscriptions'],
    });
  }

  // Entitlement reconcile: when the price maps to entitlement keys, refresh
  // the owner's client entitlement cache on EVERY status transition
  // (active/past_due/canceled all change access). Entitlements themselves
  // are derived-on-read from the updated Subscription row - this push only
  // wakes the client gate.
  const priceId = subscription.items.data[0]?.price.id;
  if (priceId && entitlementsForPriceIds([priceId]).size > 0) {
    const isUserOwned = metadata.ownerType !== SubscriptionOwnerType.Organization;
    if (isUserOwned && metadata.userId) {
      logger.info(
        `Entitlement-mapped price ${priceId} now ${subscription.status}; refreshed entitlements for user ${metadata.userId}`
      );
      await Promise.all([
        sendToClient(metadata.userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['entitlements'],
        }),
        emitMetric('Lumina5/Entitlements', 'EntitlementReconciled', 1, {
          priceId,
          status: subscription.status,
        }),
      ]);
    } else {
      // Org-seat fan-out is deferred; missing userId is a legacy-metadata
      // anomaly. Either way, surface it for on-call.
      await emitMetric('Lumina5/Entitlements', 'EntitlementSkipped', 1, {
        priceId,
        reason: isUserOwned ? 'missing_user_id' : 'org_owner_fanout_deferred',
      });
    }
  }
});
