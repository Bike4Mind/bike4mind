/* Stripe webhook ingest */

import {
  creditLotRepository,
  creditTransactionRepository,
  organizationRepository,
  userRepository,
  realtimeConnectionRepository,
} from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { CreditHolderType, CreditPurchaseEvents, CreditPurchaseStatus, isPlaceholderValue } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { subscriptionRepository } from '@server/models/Subscription';
import { Config, isDevelopment } from '@bike4mind/server-utils/utils/config';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { logEventSafe } from '@server/utils/analyticsLog';
import { StripeEvents } from '@server/utils/eventBus';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import {
  customerExists,
  CustomerType,
  isStripeConfigured,
  stripe,
} from '@bike4mind/server-utils/integrations/stripe/stripe';
import { voidOpenSubscriptionInvoices } from '@server/integrations/stripe/dunning';
import { minorUnitsPerMajor } from '@server/integrations/stripe/currency';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import {
  adminOwnerSlackRef,
  endedLifecycleEvent,
  paymentFailedLifecycleEvent,
  postSubscriptionLifecycleToSlack,
} from '@server/integrations/slack/subscriptionLifecycle';
import { sendToClient } from '@server/websocket/utils';
import { creditService, userService } from '@bike4mind/services';
import { grantCreditPurchase } from '@server/billing/grantCreditPurchase';
import { notifyCanceledForNonPayment, notifyPaymentFailed } from '@server/billing/paymentFailureNotice';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { stripeMirrorFields } from '@bike4mind/server-utils/lib/subscriptions/stripeMirror';
import { emitBillingEvent, emitPurchaseEvents } from '@server/analytics/signupEvents';
import {
  creditBuyerForEvents,
  planDetails,
  rowTimestamps,
  subscriptionEventUser,
  wholeDaysBetween,
} from '@server/analytics/billingEventDetails';
import dayjs from 'dayjs';
import { Resource } from 'sst';

// Shorter than the 10s default: the post precedes invoice voiding, which a hung webhook must not starve.
const DELETED_SLACK_POST_TIMEOUT_MS = 3_000;

const handler = baseApi({ auth: false }).post(async (req, res) => {
  if (!isStripeConfigured()) {
    req.logger.warn('Stripe webhook received but Stripe is not configured');
    return res.status(503).json({ error: 'Stripe integration not configured' });
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);

  let event;

  // In development/local environments, skip webhook signature verification (localhost only)
  if (isDevelopment()) {
    // Restrict dev bypass to localhost only - prevents LAN webhook forgery
    const ip = req.ip || req.connection.remoteAddress;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return res.status(403).json({ error: 'Dev webhook only accepts localhost connections' });
    }
    req.logger.warn('Skipping Stripe webhook signature verification in development mode (localhost)');
    try {
      event = JSON.parse(rawBody.toString());
    } catch (error) {
      req.logger.error('Failed to parse webhook payload as JSON', { error });
      throw new BadRequestError('Invalid webhook payload - not valid JSON');
    }
  } else {
    const webhookSecret = Config.STRIPE_WEBHOOK_SECRET;
    if (isPlaceholderValue(webhookSecret)) {
      req.logger.error('STRIPE_WEBHOOK_SECRET is not configured');
      return res.status(500).json({ error: 'Stripe webhook secret not configured' });
    }
    const sig = req.headers['stripe-signature'] as string;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
      // Bad/missing signature is a client error, not a server error. Returning
      // 400 prevents Stripe from retrying a payload that will never validate.
      const message = err instanceof Error ? err.message : 'Invalid Stripe webhook signature';
      req.logger.warn('Stripe webhook signature verification failed', { error: message });
      return res.status(400).json({ error: message });
    }
  }

  req.logger.updateMetadata({ event: event.type });

  req.logger.info(`Received webhook of type ${event.type}`);

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intent = event.data.object;
      const customerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;
      const trace = { paymentIntentId: intent.id, metadataUserId: intent.metadata?.userId };

      if (intent.object !== 'payment_intent') {
        req.logger.debug(`Ignoring non-invoice webhook: ${intent.object}`);
        break;
      }
      if (intent.metadata?.environment !== Resource.App.stage) {
        req.logger.debug(
          `Ignoring webhook for wrong environment: ${intent.metadata?.environment}, wanted ${Resource.App.stage}`
        );
        break;
      }
      if (!intent.metadata?.credits || Number(intent.metadata.credits) < 1) {
        // Subscription-related payment intents don't carry credits metadata
        // and are handled via invoice.payment_succeeded instead
        req.logger.debug(`Ignoring intent without credits: ${intent.id}`);
        break;
      }

      req.logger.info('[CreditPurchase] Webhook received', { step: 'webhook_received', ...trace });

      // The customer is the primary link; the server-set metadata.userId covers an intent whose
      // customer is no longer on the user (e.g. after a customer.deleted).
      const customerUser = customerId ? await userRepository.findByStripeCustomerId(customerId) : null;
      const user =
        customerUser ?? (intent.metadata?.userId ? await userRepository.findById(intent.metadata.userId) : null);
      // Both come from the same user at start-payment, so a difference means drift or tampering.
      // The customer's user still wins; this only makes the mismatch visible.
      if (customerUser && intent.metadata?.userId && customerUser.id !== intent.metadata.userId) {
        req.logger.error('[CreditPurchase] customer/metadata user mismatch', {
          step: 'user_mismatch',
          ...trace,
          customerUserId: customerUser.id,
        });
      }
      if (!user) {
        // A paid intent with no purchaser is money taken with no credits granted. Logged loudly
        // here; the creditPurchaseReconciliation cron also alerts on it.
        req.logger.error('[CreditPurchase] No user for paid credit intent, credits not granted', {
          step: 'grant_failed',
          ...trace,
        });
        break;
      }

      const credits = Number(intent.metadata.credits);
      // Ledger row and balance commit together (grantCreditPurchase), so 'already_granted' means
      // the credits really landed and a redelivery can be acknowledged. Any other failure rolled
      // back whole and throws, so Stripe retries.
      const outcome = await grantCreditPurchase(
        {
          userId: user.id,
          paymentIntentId: intent.id,
          credits,
          amount: intent.amount,
          packageId: intent.metadata.packageId,
          environment: intent.metadata.environment,
          paymentMethod: intent.payment_method_types?.[0],
        },
        req.logger
      );

      // Tell the host, and the product the buyer came through (from the touches stored at
      // signup), about the pack. Sent on a redelivery too: the eventId is keyed on the payment
      // intent, so the receiver keeps one event, and a first attempt that timed out gets another
      // chance. Never throws, so it cannot fail a delivery whose credits already landed.
      await emitPurchaseEvents({
        user,
        paymentId: intent.id,
        kind: 'credits',
        amountMinor: intent.amount_received ?? intent.amount,
        currency: intent.currency,
      });

      if (outcome === 'already_granted') {
        req.logger.info('[CreditPurchase] Credits already granted for intent', {
          step: 'already_granted',
          userId: user.id,
          ...trace,
        });
        // A first delivery that crashed after the commit never wrote its funnel row; a distinct
        // step backfills it without implying a second grant. The ledger row stays authoritative.
        await logEventSafe(
          {
            type: CreditPurchaseEvents.CREDITS_ALREADY_GRANTED,
            userId: user.id,
            metadata: { paymentIntentId: intent.id, amount: intent.amount, credits },
          },
          undefined,
          req.logger
        );
        break;
      }

      req.logger.info('[CreditPurchase] Credits granted', {
        step: 'credits_granted',
        userId: user.id,
        credits,
        amount: intent.amount,
        ...trace,
      });
      await logEventSafe(
        {
          type: CreditPurchaseEvents.CREDITS_GRANTED,
          userId: user.id,
          metadata: {
            paymentIntentId: intent.id,
            amount: intent.amount,
            credits,
            ...(intent.metadata.packageId && { packageId: intent.metadata.packageId }),
          },
        },
        undefined,
        req.logger
      );
      break;
    }

    // Subscription events

    case 'checkout.session.completed':
      break;

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;

      // In Stripe Basil+ API, invoice.subscription was moved to
      // invoice.parent.subscription_details.subscription. Support both for
      // backward compatibility during API version migration.
      const subscriptionRef = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
      const subscriptionId = typeof subscriptionRef === 'string' ? subscriptionRef : subscriptionRef?.id;

      if (!subscriptionId) {
        req.logger.debug(`Invoice ${invoice.id} has no associated subscription, skipping`);
        break;
      }

      await StripeEvents.InvoicePaymentSucceeded.publish({
        invoiceId: invoice.id,
        subscriptionId,
      });

      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;

      // Update subscription status in unified Subscription model
      const canceled = {
        status: 'canceled' as const,
        canceledAt: subscription.canceled_at ? dayjs.unix(subscription.canceled_at).toDate() : null,
        ...stripeMirrorFields(subscription),
      };
      const previous = await subscriptionRepository.updateByStripeSubscriptionIdReturningBefore(
        subscription.id,
        canceled
      );
      const updated = previous && { ...previous, ...canceled };

      // Ownership guard, and the only thing standing between a misrouted event and an
      // irreversible void: a stage with no row for this subscription does not own it
      // (the update above is then a no-op), so it must not run the money-affecting
      // cleanup below. Fails closed; the owning stage handles the same event itself.
      if (!updated) {
        req.logger.warn(`Ignoring deleted subscription ${subscription.id}: no matching row in this stage`);
        break;
      }

      // Posted by whichever write moves the row into canceled (customerSubscriptionUpdated.ts may get
      // there first); a redelivery finds it canceled, so this precedes the slower work below.
      if (previous?.status !== 'canceled') {
        await postSubscriptionLifecycleToSlack(
          endedLifecycleEvent(updated, subscription.cancellation_details?.reason),
          {
            timeoutMs: DELETED_SLACK_POST_TIMEOUT_MS,
          }
        );
      }

      // Safely access userId from metadata (may be missing for legacy subscriptions)
      const userId = subscription.metadata?.userId;
      if (userId) {
        sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['subscriptions'],
        });
      }

      // Deletion is terminal, and a Billing Portal "cancel immediately" fires this
      // without a cancel_at_period_end update. Void anything still open so Stripe
      // stops retrying the invoice and emailing the customer. A no-op when nothing
      // is open, and it must not fail the delivery - the status write above stands.
      let cleanupFailed = false;
      try {
        const { voided, failed } = await voidOpenSubscriptionInvoices(subscription.id);
        if (voided.length) {
          req.logger.info(`Voided open invoices on deleted subscription ${subscription.id}`, { voided });
        }
        if (failed.length) {
          req.logger.error(`Could not void every open invoice on deleted subscription ${subscription.id}`, { failed });
          cleanupFailed = true;
        }
      } catch (error) {
        req.logger.error(`Failed to clean up open invoices for deleted subscription ${subscription.id}`, { error });
        cleanupFailed = true;
      }
      // A half-voided subscription keeps dunning with no other signal to on-call, so
      // this emits the same metric as customerSubscriptionUpdated.ts. `emitMetric`
      // swallows its own failures, so it cannot fail a delivery that already landed.
      if (cleanupFailed) {
        await emitMetric('Lumina5/Entitlements', 'DunningCleanupFailed', 1, { reason: 'void_failed' });
      }

      // Only when Stripe's retry schedule ended in cancel. A Dashboard setting of "mark unpaid"
      // never reaches here, and would need the same notice on customer.subscription.updated.
      if (subscription.cancellation_details?.reason === 'payment_failed') {
        await notifyCanceledForNonPayment(updated, req.logger);
      }

      // Churn, whoever ended it: an in-app cancel, the Billing Portal, a period-end cancel taking
      // effect, or Stripe giving up on payment. This is the one place every path reaches. Keyed
      // on the subscription, which ends once, so a redelivery sends the same event. Never throws.
      // How long it ran is Stripe's start_date to ended_at, not canceled_at: on a period-end
      // cancel, canceled_at is when the cancel was requested, which can be weeks before the end.
      // The row's createdAt and the delivery time stand in for a payload missing either.
      const startedAt = subscription.start_date
        ? dayjs.unix(subscription.start_date).toDate()
        : rowTimestamps(updated).createdAt;
      const endedAt = subscription.ended_at ? dayjs.unix(subscription.ended_at).toDate() : new Date();
      const daysSubscribed = wholeDaysBetween(startedAt, endedAt);
      await emitBillingEvent({
        user: await subscriptionEventUser(updated),
        event: 'subscription_ended',
        occurrence: subscription.id,
        metadata: {
          reason: subscription.cancellation_details?.reason ?? 'unknown',
          ...planDetails(updated.priceId),
          ...(daysSubscribed !== undefined && { daysSubscribed }),
        },
      });

      break;
    }

    case 'checkout.session.expired': {
      const session = event.data.object;

      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      if (!customerId) {
        req.logger.debug(`Ignoring session without customer: ${session.id}`);
        break;
      }

      if (await customerExists(customerId)) {
        break;
      }

      // No user/org associated with this customer - delete it from Stripe to avoid an orphan
      await stripe.customers.del(customerId);
      req.logger.info(`Deleted customer ${customerId} because it is not associated with any users or organizations`);

      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;

      await StripeEvents.CustomerSubscriptionUpdated.publish({
        subscriptionId: subscription.id,
      });

      break;
    }

    case 'customer.deleted': {
      const customer = event.data.object;

      if (!customer.metadata.type || customer.metadata.type === CustomerType.User) {
        const user = await userRepository.findByStripeCustomerId(customer.id);
        if (!user) {
          req.logger.warn(`User with Stripe customer ID ${customer.id} not found`);
          break;
        }

        await userRepository.update({ id: user.id, stripeCustomerId: null });
        req.logger.info(`Removed Stripe customer ID from user ${user.id}`);
      } else {
        const organization = await organizationRepository.findByStripeCustomerId(customer.id);
        if (!organization) {
          req.logger.warn(`Organization with Stripe customer ID ${customer.id} not found`);
          break;
        }

        await organizationRepository.update({ id: organization.id, stripeCustomerId: null });
        req.logger.info(`Removed Stripe customer ID from organization ${organization.id}`);
      }

      break;
    }

    // Fraud prevention events

    case 'charge.dispute.created': {
      const dispute = event.data.object;
      const paymentIntentId =
        typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;

      let user = null;

      if (paymentIntentId) {
        const originalTx = await creditTransactionRepository.findByPaymentIntentId(paymentIntentId);
        if (originalTx) {
          user = await userRepository.findById(originalTx.ownerId);
          if (user) {
            // Clawback the disputed credits (idempotent via stripeDisputeId unique index)
            try {
              await creditService.subtractCredits(
                {
                  type: 'generic_deduct',
                  ownerId: user.id, // Always clawback from user, not org
                  ownerType: CreditHolderType.User,
                  credits: originalTx.credits,
                  reason: 'dispute_clawback',
                  stripeDisputeId: dispute.id,
                  description: `Dispute clawback: Stripe dispute ${dispute.id}`,
                },
                {
                  db: { creditTransactions: creditTransactionRepository },
                  creditHolderMethods: userRepository,
                }
              );
              req.logger.info(`Clawback of ${originalTx.credits} credits completed for dispute ${dispute.id}`);

              // Kill the matching pack lot's remaining balance. No-op if no lot
              // matches (e.g. a subscription grant stamped with an invoice-id ref).
              await creditService.clawbackCreditLotsByStripeRef(paymentIntentId, 'full', originalTx.credits, {
                db: { creditLots: creditLotRepository },
              });
            } catch (err: unknown) {
              // Duplicate key (code 11000) = already processed - idempotent no-op
              if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
                req.logger.info(`Dispute ${dispute.id} already processed (duplicate key), skipping clawback`);
              } else {
                throw err;
              }
            }
          }
        }
      }

      // Fall back to customer-ID lookup if payment intent didn't resolve a user
      if (!user) {
        const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
        if (chargeId) {
          const charge = await stripe.charges.retrieve(chargeId);
          const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
          if (customerId) {
            user = await userRepository.findByStripeCustomerId(customerId);
            if (!user) {
              // Check if it belongs to an org (subscription dispute)
              const org = await organizationRepository.findByStripeCustomerId(customerId);
              if (org) {
                await postMessageToSlack(
                  `\u26A0\uFE0F *Stripe Dispute (Subscription/Org)* \u2014 dispute ${dispute.id}\n*Organization:* ${adminOwnerSlackRef({ ownerType: SubscriptionOwnerType.Organization, ownerId: org.id })}\n*Amount:* $${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}\n*Reason:* ${dispute.reason}\nNo automatic clawback for org subscription disputes. Admin action required.`
                );
                req.logger.warn(`Dispute ${dispute.id} linked to org ${org.id}, manual review needed`);
                break;
              }
            }
          }
        }
      }

      if (user) {
        const { deactivatedKeys } = await userService.flagDisputePending(user, {
          db: {
            users: userRepository,
            userApiKeys: userApiKeyRepository,
            realtimeConnections: realtimeConnectionRepository,
          },
        });

        await postMessageToSlack(
          `\u{1F6A8} *Stripe Dispute Created* \u2014 dispute ${dispute.id}\n*User:* ${adminOwnerSlackRef({ ownerType: SubscriptionOwnerType.User, ownerId: user.id })}\n*Amount:* $${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}\n*Reason:* ${dispute.reason}\nAccount flagged, credits clawback initiated${deactivatedKeys ? ', API keys deactivated' : ''}.`
        );
        req.logger.info(`User ${user.id} flagged disputePending=true for dispute ${dispute.id}`);
      } else {
        await postMessageToSlack(
          `\u26A0\uFE0F *Stripe Dispute Created \u2014 No User Found* \u2014 dispute ${dispute.id}\n*Amount:* $${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}\n*Reason:* ${dispute.reason}\nCould not identify user. Manual review required.`
        );
        req.logger.warn(`Could not find user for dispute ${dispute.id}`);
      }

      break;
    }

    case 'charge.dispute.closed': {
      const dispute = event.data.object;

      // Only act when the merchant wins - lost disputes stay flagged pending manual review
      if (dispute.status !== 'won') {
        req.logger.debug(`Dispute ${dispute.id} closed with status ${dispute.status}, no action taken`);
        break;
      }

      // Find the user via payment intent -> credit transaction, same lookup as charge.dispute.created
      let user = null;
      const paymentIntentId =
        typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;

      if (paymentIntentId) {
        const originalTx = await creditTransactionRepository.findByPaymentIntentId(paymentIntentId);
        if (originalTx) {
          user = await userRepository.findById(originalTx.ownerId);
        }
      }

      if (!user) {
        const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
        if (chargeId) {
          const charge = await stripe.charges.retrieve(chargeId);
          const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
          if (customerId) {
            user = await userRepository.findByStripeCustomerId(customerId);
          }
        }
      }

      if (user) {
        await userRepository.update({ id: user.id, disputePending: false });

        await postMessageToSlack(
          `\u2705 *Stripe Dispute Won* \u2014 dispute ${dispute.id}\n*User:* ${adminOwnerSlackRef({ ownerType: SubscriptionOwnerType.User, ownerId: user.id })}\n*Amount:* $${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}\nAccount dispute flag cleared.`
        );
        req.logger.info(`Cleared disputePending for user ${user.id} after winning dispute ${dispute.id}`);
      } else {
        req.logger.warn(`Could not find user for won dispute ${dispute.id}`);
      }

      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object;
      const refunds = charge.refunds?.data ?? [];
      if (refunds.length === 0) {
        req.logger.debug(`charge.refunded has no refund objects, skipping`);
        break;
      }

      const refundPaymentIntentId =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;

      if (!refundPaymentIntentId) {
        req.logger.debug(`charge.refunded has no payment_intent, skipping`);
        break;
      }

      const originalTx = await creditTransactionRepository.findByPaymentIntentId(refundPaymentIntentId);
      if (!originalTx) {
        req.logger.debug(`No credit purchase found for refunded charge ${charge.id}, skipping`);
        break;
      }

      const user = await userRepository.findById(originalTx.ownerId);
      if (!user) {
        req.logger.warn(`User ${originalTx.ownerId} not found for refunded charge ${charge.id}`);
        break;
      }

      // Process each refund independently - idempotency enforced via stripeRefundId unique sparse index
      const originalAmount = charge.amount_captured || charge.amount;
      for (const refund of refunds) {
        // Proportional clawback: refundAmount / originalChargeAmount * purchasedCredits
        const refundRatio = originalAmount > 0 ? refund.amount / originalAmount : 0;
        const creditsToClawback = Math.round(originalTx.credits * refundRatio);

        if (creditsToClawback <= 0) {
          req.logger.debug(`Computed 0 credits to clawback for refund ${refund.id}, skipping`);
          continue;
        }

        try {
          await creditService.subtractCredits(
            {
              type: 'generic_deduct',
              ownerId: user.id, // Always clawback from user, not org
              ownerType: CreditHolderType.User,
              credits: creditsToClawback,
              reason: 'refund_clawback',
              stripeRefundId: refund.id,
              description: `Refund clawback: Stripe refund ${refund.id} (${Math.round(refundRatio * 100)}% of purchase)`,
            },
            {
              db: { creditTransactions: creditTransactionRepository },
              creditHolderMethods: userRepository,
            }
          );
          req.logger.info(`Clawback of ${creditsToClawback} credits completed for refund ${refund.id}`);

          // Proportionally shrink the matching pack lot's remaining balance.
          // No-op if no lot matches.
          await creditService.clawbackCreditLotsByStripeRef(refundPaymentIntentId, 'proportional', creditsToClawback, {
            db: { creditLots: creditLotRepository },
          });

          await postMessageToSlack(
            `\u2139\uFE0F *Stripe Refund* \u2014 refund ${refund.id}\n*User:* ${adminOwnerSlackRef({ ownerType: SubscriptionOwnerType.User, ownerId: user.id })}\n*Refund Amount:* $${(refund.amount / 100).toFixed(2)}\n*Credits Clawed Back:* ${creditsToClawback} (${Math.round(refundRatio * 100)}% of purchase)`
          );
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
            req.logger.info(`Refund ${refund.id} already processed (duplicate key), skipping clawback`);
            continue;
          }
          throw err;
        }
      }

      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const subscriptionRef = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
      const subscriptionId = typeof subscriptionRef === 'string' ? subscriptionRef : subscriptionRef?.id;

      if (!subscriptionId) {
        req.logger.debug(`invoice.payment_failed ${invoice.id} has no subscription, skipping`);
        break;
      }

      const updated = await subscriptionRepository.markPastDue(subscriptionId);

      // Same ownership guard as customer.subscription.deleted: a stage with no row for this
      // subscription does not own it, and must not email its owner. Also null for a row already
      // closed, since a late delivery of this event can arrive after the deletion.
      if (!updated) {
        req.logger.warn(
          `Ignoring payment failure on subscription ${subscriptionId}: no row in this stage, or it is already closed`
        );
        break;
      }

      // The owner comes from the row: Stripe does not copy subscription metadata onto the invoice,
      // so `invoice.metadata.userId` is never set.
      const userId = updated.ownerType === SubscriptionOwnerType.User ? updated.ownerId : null;
      if (userId) {
        sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['subscriptions'],
        });
      }

      // First attempt only: Stripe's retries would otherwise post once per attempt.
      if (invoice.attempt_count === 1) {
        await postSubscriptionLifecycleToSlack(paymentFailedLifecycleEvent(updated, invoice));
      }
      req.logger.info(`Subscription ${subscriptionId} set to past_due after payment failure`);

      await notifyPaymentFailed(updated, invoice, req.logger);

      // Each failed attempt is its own event: the row comes back on every retry, so the attempt
      // number goes into the occurrence, and a redelivery of the same attempt sends the same id.
      // Nothing for an invoice with nothing due. Never throws.
      if (invoice.amount_due > 0 && invoice.currency) {
        await emitBillingEvent({
          user: await subscriptionEventUser(updated),
          event: 'payment_failed',
          occurrence: `${invoice.id}:${invoice.attempt_count ?? 0}`,
          metadata: {
            kind: 'subscription',
            value: invoice.amount_due / minorUnitsPerMajor(invoice.currency),
            currency: invoice.currency.toUpperCase(),
            attempt: invoice.attempt_count ?? 0,
            ...(invoice.billing_reason && { billingReason: invoice.billing_reason }),
          },
        });
      }

      break;
    }

    case 'payment_intent.payment_failed': {
      const intent = event.data.object;

      // Only act if credits were pre-allocated for this payment intent
      const failedTx = await creditTransactionRepository.findByPaymentIntentId(intent.id);
      if (failedTx) {
        // Mark transaction as failed (idempotent - no unique constraint needed here)
        await creditTransactionRepository.updateTransactionStatus(intent.id, CreditPurchaseStatus.Failed);

        req.logger.info(`Marked credit transaction ${failedTx.id} as failed for payment_intent ${intent.id}`);
      } else {
        req.logger.debug(`No pre-allocated credits found for failed payment_intent ${intent.id}, skipping`);
      }

      // A failed credit-pack payment, reported whether or not the ledger above had a row: it only
      // ever holds completed purchases (grantCreditPurchase writes on success, and start-payment
      // writes nothing), so a real failure finds none. After the ledger work, so a slow or broken
      // emit cannot hold it up. The same filters as payment_intent.succeeded keep subscription
      // intents (invoice.payment_failed reports those) and other stages' intents out. One event
      // per failed confirmation, keyed on the Stripe event, which a redelivery repeats. Never throws.
      if (
        intent.metadata?.environment === Resource.App.stage &&
        Number(intent.metadata?.credits) >= 1 &&
        intent.amount > 0 &&
        intent.currency
      ) {
        const customerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;
        await emitBillingEvent({
          user: await creditBuyerForEvents(customerId, intent.metadata?.userId),
          event: 'payment_failed',
          occurrence: event.id,
          metadata: {
            kind: 'credits',
            value: intent.amount / minorUnitsPerMajor(intent.currency),
            currency: intent.currency.toUpperCase(),
          },
        });
      }

      break;
    }

    default: {
      req.logger.debug(`Ignoring webhook of type ${event.type}`);
    }
  }

  return res.status(200).send();
});

export const config = {
  api: {
    bodyParser: false, // raw body needed for Stripe signature verification
    externalResolver: true,
  },
};

export default handler;
