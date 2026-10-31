import { organizationRepository, withTransaction } from '@bike4mind/database';
import { entitlementsForPriceIds } from '@bike4mind/server-utils/lib/entitlements/registry';
import { StripeSubscriptionMetadataSchema } from '@bike4mind/server-utils/lib/subscriptions/schema';
import { stripeMirrorFields } from '@bike4mind/server-utils/lib/subscriptions/stripeMirror';
import {
  type ISubscription,
  SubscriptionMetadata,
  SubscriptionOwnerType,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import { emitBillingEvent } from '@server/analytics/signupEvents';
import {
  planChangeDirection,
  planDetails,
  rowTimestamps,
  subscriptionEventUser,
} from '@server/analytics/billingEventDetails';
import type Stripe from 'stripe';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { setSeats } from '@server/services/organizationService';
import { Config } from '@bike4mind/server-utils/utils/config';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { StripeEvents } from '@server/utils/eventBus';
import { voidOpenSubscriptionInvoices } from '@bike4mind/server-utils/integrations/stripe/dunning';
import { postSubscriptionChangesToSlack } from '@server/integrations/slack/subscriptionLifecycle';
import { detectSubscriptionChanges } from '@bike4mind/server-utils/lib/subscriptions/subscriptionChanges';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import dayjs from 'dayjs';
import { Resource } from 'sst';
import { withEventContext } from '@workers/utils/eventContext';

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

  // Ownership: the write below finding a row is the only evidence this stage owns
  // the subscription, and the invoice cleanup is an irreversible money-affecting
  // write - so it must not run for an event this stage has no row for (a
  // Dashboard-created subscription, or an event fanned out to several stage
  // endpoints). Same guard as the `deleted` branch in pages/api/stripe/webhook.ts.
  let owned = false;
  // The row as this update's own write found it, for the lifecycle events below. The write
  // replaces it with Stripe's current state and this event carries only the subscription id, so
  // the pre-image is the one record of what changed. Taken from the write rather than a read
  // before it, so an update running alongside cannot slip in between and leave this comparing
  // against a state that is already gone. Nothing extra to fail: the sync either writes and
  // returns it, or fails as it always could. The cancel and change routes do not write the row
  // themselves, so an in-app change reaches here exactly as a Billing Portal one does.
  let before: ISubscription | null = null;

  // Update subscription in unified Subscription model
  const shouldInvalidateOrgs = await withTransaction(async () => {
    const [item] = subscription.items.data;
    // Reassigned on a retried transaction, so both hold the attempt that committed.
    before = await subscriptionRepository.updateByStripeSubscriptionIdReturningBefore(subscription.id, {
      status: subscription.status,
      periodStartsAt: dayjs.unix(item.current_period_start).toDate(),
      periodEndsAt: dayjs.unix(item.current_period_end).toDate(),
      canceledAt: subscription.canceled_at ? dayjs.unix(subscription.canceled_at).toDate() : null,
      priceId: item.price.id,
      quantity: item.quantity ?? 1,
      ...stripeMirrorFields(subscription),
    });
    owned = before !== null;

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
          await organizationRepository.update({ id: organization.id, seats: newQuantity });
        }
        return true;
      }
    }

    if (!owned) {
      logger.warn(`Subscription not found: ${subscription.id}`);
      return false;
    }

    return false;
  });

  // Straight after the write: a redelivery compares Stripe's state with the row this attempt wrote
  // and finds no change, so a timeout in the slower work below would lose these posts. Never throws.
  if (owned && before) {
    await postSubscriptionChangesToSlack(before, subscription);
  }

  // A cancel recorded at Stripe - the Billing Portal path, where Stripe is the
  // only actor and none of our API routes are called - leaves the unpaid invoice
  // that triggered the dunning still open, and Stripe keeps retrying it and
  // emailing the customer. Close it here, once the sync above has confirmed the
  // row is ours. Cleanup must not break the delivery, so failures are swallowed
  // and surfaced.
  //
  // Bounded to invoices that already existed when the cancel was requested: this
  // event fires on every later update too, and a subscriber can still spend while
  // a period-end cancellation is pending. A fresh proration invoice from such a
  // change is a real charge, not the stale dunning one this is here to close.
  if (owned && (subscription.cancel_at_period_end || subscription.canceled_at)) {
    let cleanupFailed = false;
    try {
      const { voided, failed } = await voidOpenSubscriptionInvoices(subscription.id, {
        createdBefore: subscription.canceled_at,
      });
      if (voided.length) logger.info(`Voided open invoices on cancelled subscription ${subscription.id}`, { voided });
      if (failed.length) {
        logger.error(`Could not void every open invoice on cancelled subscription ${subscription.id}`, { failed });
        cleanupFailed = true;
      }
    } catch (error) {
      logger.error(`Failed to clean up open invoices for cancelled subscription ${subscription.id}`, { error });
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      await emitMetric('Lumina5/Entitlements', 'DunningCleanupFailed', 1, { reason: 'void_failed' });
    }
  }

  // After the invoice cleanup, so a slow analytics emit cannot hold up the void that stops
  // dunning, and before anything else that could throw: everything above swallows its own
  // failures, so once the write commits nothing can skip these. Never throws.
  if (owned && before) {
    await emitSubscriptionChangeEvents(before, subscription);
  }

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

/**
 * The lifecycle events one subscription update carries, read off the row its write replaced and
 * Stripe's state after it: a move to another price, and a period-end cancel being set or
 * withdrawn. This event fires on every update (renewals, seat changes, status moves), so each is
 * sent only when this write changed the row, not on a write that repeats the state it found. A
 * subscription that is over is customer.subscription.deleted's to report (subscription_ended),
 * not this one's.
 *
 * The events follow the row, which is only as current as the Stripe state each update fetched.
 * Updates running at once each see the state the other left, so they cannot both report one
 * transition; but one that fetched an older state and wrote it last moves the row back, reports
 * that move unless the row was terminal, and the next update reports the move forward again.
 *
 * Only user-owned subscriptions, like purchases: no one user's signup can attribute an
 * organization's. Each occurrence names the row version it changed from, so each transition has
 * its own eventId. Never throws.
 */
async function emitSubscriptionChangeEvents(before: ISubscription, subscription: Stripe.Subscription) {
  try {
    const user = await subscriptionEventUser(before);
    if (!user) return;
    const toPriceId = subscription.items.data[0]?.price.id;
    const version = rowTimestamps(before).updatedAt?.toISOString() ?? 'unversioned';
    const sends: Array<Promise<unknown>> = [];
    const { plan, cancel } = detectSubscriptionChanges(before, subscription);

    if (plan) {
      const from = planDetails(plan.fromPriceId);
      const to = planDetails(plan.toPriceId);
      sends.push(
        emitBillingEvent({
          user,
          event: 'plan_changed',
          occurrence: `${subscription.id}:plan:${version}`,
          metadata: {
            fromPlan: from.plan,
            toPlan: to.plan,
            ...(from.interval && { fromInterval: from.interval }),
            ...(to.interval && { toInterval: to.interval }),
            direction: planChangeDirection(plan.fromPriceId, plan.toPriceId),
          },
        })
      );
    }

    if (cancel) {
      sends.push(
        emitBillingEvent({
          user,
          event: cancel === 'scheduled' ? 'subscription_cancel_scheduled' : 'subscription_cancel_reverted',
          occurrence: `${subscription.id}:cancel:${version}`,
          metadata: { ...planDetails(toPriceId ?? before.priceId) },
        })
      );
    }

    await Promise.all(sends);
  } catch {
    console.warn('[b4m-analytics] subscription change events failed');
  }
}
