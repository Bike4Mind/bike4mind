/* Stripe webhook ingest */

import {
  creditLotRepository,
  creditTransactionRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { CreditHolderType, CreditPurchaseStatus, isPlaceholderValue } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { subscriptionRepository } from '@server/models/Subscription';
import { Config, isDevelopment } from '@server/utils/config';
import { StripeEvents } from '@server/utils/eventBus';
import { BadRequestError } from '@server/utils/errors';
import { customerExists, CustomerType, isStripeConfigured, stripe } from '@server/integrations/stripe/stripe';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { sendToClient } from '@server/websocket/utils';
import { creditService } from '@bike4mind/services';
import dayjs from 'dayjs';
import { Resource } from 'sst';

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
      if (!intent.customer) {
        req.logger.debug(`Ignoring intent without customer: ${intent.id}`);
        break;
      }

      const customerId = typeof intent.customer === 'string' ? intent.customer : intent.customer.id;
      const user = await userRepository.findByStripeCustomerId(customerId);
      if (!user) {
        req.logger.debug(`no such user with stripe ID: ${intent.customer}`);
        break;
      }

      if (intent.object !== 'payment_intent') {
        req.logger.debug(`Ignoring non-invoice webhook: ${intent.object}`);
      } else if (intent.metadata?.environment !== Resource.App.stage) {
        req.logger.debug(
          `Ignoring webhook for wrong environment: ${intent.metadata?.environment}, wanted ${Resource.App.stage}`
        );
      } else if (!intent.metadata?.credits || Number(intent.metadata.credits) < 1) {
        // Subscription-related payment intents don't carry credits metadata
        // and are handled via invoice.payment_succeeded instead
        req.logger.debug(`Ignoring intent without credits: ${intent.id}`);
      } else {
        req.logger.info(`Adding ${intent.metadata.credits} credits to user ${user.id}`);

        // Create credit transaction record
        await creditTransactionRepository.createTransaction('purchase', {
          ownerId: user.id,
          ownerType: CreditHolderType.User,
          amount: intent.amount,
          credits: Number(intent.metadata.credits),
          status: CreditPurchaseStatus.Completed,
          stripePaymentIntentId: intent.id,
          packageId: intent.metadata.packageId,
          metadata: {
            environment: intent.metadata.environment,
            paymentMethod: intent.payment_method_types?.[0],
          },
        });

        // Update user's credit balance
        user.currentCredits += Number(intent.metadata.credits);
        await userRepository.update(user);

        // Bypasses addCredits (this path predates it), so stamp the pack lot
        // inline here rather than through the central seam. Best-effort - see
        // stampCreditLot.
        await creditService.stampCreditLot(
          {
            ownerId: user.id,
            ownerType: CreditHolderType.User,
            amount: Number(intent.metadata.credits),
            grantType: 'purchase',
            stripeRef: intent.id,
          },
          { db: { creditLots: creditLotRepository } }
        );
      }
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
      await subscriptionRepository.updateByStripeSubscriptionId(subscription.id, {
        status: 'canceled',
        canceledAt: subscription.canceled_at ? dayjs.unix(subscription.canceled_at).toDate() : null,
      });

      // Safely access userId from metadata (may be missing for legacy subscriptions)
      const userId = subscription.metadata?.userId;
      if (userId) {
        sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['subscriptions'],
        });
      }

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

        user.stripeCustomerId = null;
        await userRepository.update(user);
        req.logger.info(`Removed Stripe customer ID from user ${user.id}`);
      } else {
        const organization = await organizationRepository.findByStripeCustomerId(customer.id);
        if (!organization) {
          req.logger.warn(`Organization with Stripe customer ID ${customer.id} not found`);
          break;
        }

        organization.stripeCustomerId = null;
        await organizationRepository.update(organization);
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
                  `⚠️ *Stripe Dispute (Subscription/Org)* — dispute ${dispute.id}\n*Organization:* ${org.name} (${org.id})\n*Amount:* $${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}\n*Reason:* ${dispute.reason}\nNo automatic clawback for org subscription disputes. Admin action required.`
                );
                req.logger.warn(`Dispute ${dispute.id} linked to org ${org.id}, manual review needed`);
                break;
              }
            }
          }
        }
      }

      if (user) {
        user.disputePending = true;
        await userRepository.update(user);

        await postMessageToSlack(
          `🚨 *Stripe Dispute Created* — dispute ${dispute.id}\n*User:* ${user.name || user.email} (${user.id})\n*Amount:* $${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}\n*Reason:* ${dispute.reason}\nAccount flagged, credits clawback initiated.`
        );
        req.logger.info(`User ${user.id} flagged disputePending=true for dispute ${dispute.id}`);
      } else {
        await postMessageToSlack(
          `⚠️ *Stripe Dispute Created — No User Found* — dispute ${dispute.id}\n*Amount:* $${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}\n*Reason:* ${dispute.reason}\nCould not identify user. Manual review required.`
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
        user.disputePending = false;
        await userRepository.update(user);

        await postMessageToSlack(
          `✅ *Stripe Dispute Won* — dispute ${dispute.id}\n*User:* ${user.name || user.email} (${user.id})\n*Amount:* $${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}\nAccount dispute flag cleared.`
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
            `ℹ️ *Stripe Refund* — refund ${refund.id}\n*User:* ${user.name || user.email} (${user.id})\n*Refund Amount:* $${(refund.amount / 100).toFixed(2)}\n*Credits Clawed Back:* ${creditsToClawback} (${Math.round(refundRatio * 100)}% of purchase)`
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

      await subscriptionRepository.updateByStripeSubscriptionId(subscriptionId, {
        status: 'past_due',
      });

      const userId = invoice.metadata?.userId ?? null;
      if (userId) {
        sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['subscriptions'],
        });
      }

      await postMessageToSlack(
        `⚠️ *Subscription Payment Failed* — invoice ${invoice.id}\n*Subscription:* ${subscriptionId}\n${userId ? `*User ID:* ${userId}\n` : ''}Status set to past_due.`
      );
      req.logger.info(`Subscription ${subscriptionId} set to past_due after payment failure`);

      break;
    }

    case 'payment_intent.payment_failed': {
      const intent = event.data.object;

      // Only act if credits were pre-allocated for this payment intent
      const failedTx = await creditTransactionRepository.findByPaymentIntentId(intent.id);
      if (!failedTx) {
        req.logger.debug(`No pre-allocated credits found for failed payment_intent ${intent.id}, skipping`);
        break;
      }

      // Mark transaction as failed (idempotent - no unique constraint needed here)
      await creditTransactionRepository.updateTransactionStatus(intent.id, CreditPurchaseStatus.Failed);

      req.logger.info(`Marked credit transaction ${failedTx.id} as failed for payment_intent ${intent.id}`);

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
