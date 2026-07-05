import {
  creditTransactionRepository,
  organizationRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';

import { SubscriptionMetadata, SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';

import { Logger } from '@bike4mind/observability';
import Stripe from 'stripe';
import { subscriptionRepository } from '@server/models/Subscription';
import { resolveSubscriptionSource } from '@server/services/organizationService';
import { sendToClient } from '@server/websocket/utils';
import { emitMetric } from '@server/utils/cloudwatch';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { organizationService, creditService } from '@bike4mind/services';
import { ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT } from '../subscriptions/constants';
import { CreditHolderType, IOrganizationDocument, dayjs } from '@bike4mind/common';
import { Resource } from 'sst';

/**
 * Add credits to an organization and record a credit transaction.
 */
const addOrganizationCredits = async ({
  organization,
  creditsToAdd,
  userId,
  paymentIntentId,
  invoiceId,
  metadata,
}: {
  organization: Awaited<ReturnType<typeof organizationRepository.findById>>;
  creditsToAdd: number;
  userId: string;
  paymentIntentId: string;
  invoiceId: string;
  metadata: {
    type: 'subscription_initial_seats' | 'subscription_seat_increase' | 'subscription_renewal';
    [key: string]: any;
  };
}) => {
  if (!organization || creditsToAdd <= 0) return;

  // Use atomic increment operation instead of direct update
  try {
    await creditService.addCredits(
      {
        ownerId: organization.id,
        ownerType: CreditHolderType.Organization,
        credits: creditsToAdd,
        type: 'subscription',
        metadata,
        stripePaymentIntentId: paymentIntentId || invoiceId || undefined,
      },
      {
        db: {
          creditTransactions: creditTransactionRepository,
        },
        creditHolderMethods: organizationRepository,
      }
    );
  } catch (err: unknown) {
    // E11000: concurrent webhook retry already committed this transaction - treat as success
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000) {
      return creditsToAdd;
    }
    throw err;
  }

  return creditsToAdd;
};

/**
 * Handle organization subscription invoice payment
 * This includes:
 * - Initial subscription creation
 * - Organization creation for new organizations
 * - Subscription renewals
 * - Seat quantity updates (with proration)
 */
export const handleOrganizationSubscriptionInvoice = async (
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  metadata: SubscriptionMetadata,
  logger: Logger
) => {
  if (metadata.ownerType !== SubscriptionOwnerType.Organization) {
    logger.debug(`Ignoring non-organization subscription: ${subscription.id}`);
    return;
  }

  if (!invoice.customer) {
    logger.error(`Invoice without customer: ${invoice.id}`);
    return;
  }

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id;

  const user = await userRepository.findById(metadata.userId);
  if (!user) {
    logger.debug(`No user found for ID: ${metadata.userId}`);
    return;
  }

  const [item] = subscription.items.data;
  const subscriptionQuantity = item.quantity ?? 1;
  const periodStart = item.current_period_start;
  const periodEnd = item.current_period_end;

  // In v22+, invoice.payment_intent was removed; extract from invoice.payments
  const paymentIntentId =
    (invoice.payments?.data[0]?.payment?.type === 'payment_intent'
      ? typeof invoice.payments.data[0].payment.payment_intent === 'string'
        ? invoice.payments.data[0].payment.payment_intent
        : invoice.payments.data[0].payment.payment_intent?.id
      : undefined) ?? '';

  // Use invoice.id as fallback when paymentIntentId is empty (e.g. non-card payment methods).
  // An empty paymentIntentId bypasses BOTH the application pre-check and the DB sparse unique
  // index, allowing unlimited credit duplication on Stripe retries (up to ~15 over 3 days).
  const idempotencyKey = paymentIntentId || invoice.id;

  let organization: IOrganizationDocument | null = null;
  const promises: Promise<void>[] = [];

  await withTransaction(async () => {
    // Handle different billing scenarios
    switch (invoice.billing_reason) {
      case 'subscription_create': {
        // For new subscriptions, handle organization creation or use existing one
        if (metadata.organizationId) {
          organization = await organizationRepository.findById(metadata.organizationId);
          if (!organization) {
            logger.debug(`Ignoring unknown organization: ${metadata.organizationId}`);
            return;
          }
        } else if (metadata.newOrganizationName) {
          // Create a new organization only during subscription creation
          organization = await organizationService.create(
            user,
            {
              name: metadata.newOrganizationName,
              seats: subscriptionQuantity,
              personal: false,
              stripeCustomerId: customerId,
            },
            {
              db: {
                organizations: organizationRepository,
              },
            }
          );

          if (!organization) {
            logger.error(`Failed to create organization: ${metadata.newOrganizationName}`);
            return;
          }

          logger.info(`Organization created: ${organization.name} (${organization.id})`);
        } else {
          logger.debug(`Ignoring subscription creation without organization details: ${subscription.id}`);
          return;
        }

        // Do not create a new subscription record if it already exists
        const existingSubscription = await subscriptionRepository.findByStripeSubscriptionId(subscription.id);
        if (existingSubscription) {
          logger.debug(`Subscription with stripe ID ${subscription.id} already exists`);
          break;
        }

        // TS narrowing is lost across the await above; all branches that reach here
        // have assigned `organization` to a non-null value (other branches returned).
        if (!organization) return;
        // Capture to a const so narrowing persists across the awaits below.
        const org = organization;

        // Conversion flip: if an admin_grant sub already exists for this org,
        // upgrade it to Stripe in place rather than inserting a duplicate row.
        // Keeps a single Subscription row across the grant->paid lifecycle.
        const activeSubs = await subscriptionRepository.findActiveSubscriptionsByOwner(
          SubscriptionOwnerType.Organization,
          org.id
        );
        const adminGrant = activeSubs.find(s => resolveSubscriptionSource(s) === SubscriptionSource.AdminGrant);

        if (adminGrant) {
          // Atomic flip: findOneAndUpdate with `source: 'admin_grant'` in the
          // filter means concurrent webhooks (or a retry hitting in parallel
          // with the original) can't both flip the same row - the loser sees
          // a null result. Without this, a race could double-grant credits.
          const flipped = await subscriptionRepository.flipAdminGrantToStripe(adminGrant.id, {
            source: SubscriptionSource.Stripe,
            subscriptionId: subscription.id,
            priceId: item.price.id,
            status: subscription.status,
            periodStartsAt: dayjs.unix(periodStart).toDate(),
            periodEndsAt: dayjs.unix(periodEnd).toDate(),
            canceledAt: null,
            quantity: subscriptionQuantity,
          });
          if (!flipped) {
            logger.warn(
              `admin_grant ${adminGrant.id} for org ${org.id} was already flipped by a concurrent writer — skipping duplicate credit grant for ${subscription.id}`
            );
            break;
          }
          logger.info(`Flipped admin_grant subscription ${adminGrant.id} → stripe for org ${org.id}`);
        } else {
          // Defense against double-Convert-to-paid races: if another active
          // Stripe subscription already exists for this org, do NOT create a
          // second one - that would result in the customer being billed twice.
          // The admin should reconcile in Stripe Dashboard.
          const existingStripeSub = activeSubs.find(s => resolveSubscriptionSource(s) === SubscriptionSource.Stripe);
          if (existingStripeSub) {
            logger.warn(
              `Org ${org.id} already has an active Stripe subscription ${existingStripeSub.subscriptionId ?? '(no stripe id)'} — refusing to create duplicate from ${subscription.id}. Manual reconciliation required.`
            );
            break;
          }

          await subscriptionRepository.create({
            ownerType: SubscriptionOwnerType.Organization,
            ownerId: org.id,
            subscriptionId: subscription.id,
            priceId: item.price.id,
            status: subscription.status,
            source: SubscriptionSource.Stripe,
            periodStartsAt: dayjs.unix(periodStart).toDate(),
            periodEndsAt: dayjs.unix(periodEnd).toDate(),
            canceledAt: null,
            quantity: subscriptionQuantity,
          });
        }

        // Add initial credits based on number of seats
        const creditsToAdd = subscriptionQuantity * ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT;
        const addedCredits = await addOrganizationCredits({
          organization: org,
          creditsToAdd,
          userId: metadata.userId,
          paymentIntentId,
          invoiceId: invoice.id,
          metadata: {
            type: 'subscription_initial_seats',
            seats: subscriptionQuantity,
          },
        });

        if (addedCredits) {
          logger.info(
            `Added ${addedCredits} initial credits to organization ${org.id} for ${subscriptionQuantity} seats`
          );
        }
        break;
      }

      case 'subscription_update': {
        // For updates and renewals, always use existing organization by customer ID
        organization = await organizationRepository.findByStripeCustomerId(customerId);
        if (!organization) {
          logger.debug(`No organization found for customer ID: ${customerId}`);
          return;
        }

        // Calculate the seat change by comparing with previous quantity
        const previousQuantity = invoice.lines.data[0].quantity ?? 0;
        const currentQuantity = subscriptionQuantity;
        const seatIncrease = currentQuantity - previousQuantity;

        // Calculate prorated credits based on remaining days in billing period
        const currentPeriodEnd = dayjs.unix(periodEnd);
        const currentPeriodStart = dayjs.unix(periodStart);
        const invoiceCreateTimestamp = dayjs.unix(invoice.created);
        const daysInPeriod = currentPeriodEnd.diff(currentPeriodStart, 'days');
        const daysRemaining = currentPeriodEnd.diff(invoiceCreateTimestamp, 'days');
        const prorationFactor = daysRemaining / daysInPeriod;

        // Detailed logging of proration calculation
        logger.info('Proration calculation details:', {
          timing: {
            currentPeriodStart: currentPeriodStart.format(),
            currentPeriodEnd: currentPeriodEnd.format(),
            invoiceCreateTimestamp: invoiceCreateTimestamp.format(),
            daysInPeriod,
            daysRemaining,
          },
          seats: {
            previousQuantity,
            currentQuantity,
            seatIncrease,
          },
          credits: {
            fullCreditsPerSeat: ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT,
            prorationFactor: Number(prorationFactor.toFixed(4)),
          },
        });

        // Calculate prorated credits
        const fullCreditsPerSeat = ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT;
        const proratedCreditsPerSeat = Math.floor(fullCreditsPerSeat * prorationFactor);
        const creditsToAdd = seatIncrease * proratedCreditsPerSeat;

        if (creditsToAdd > 0) {
          const addedCredits = await addOrganizationCredits({
            organization,
            creditsToAdd,
            userId: metadata.userId,
            paymentIntentId,
            invoiceId: invoice.id,
            metadata: {
              type: 'subscription_seat_increase',
              seatIncrease,
              previousQuantity,
              currentQuantity,
              prorationFactor,
              proratedCreditsPerSeat,
              fullCreditsPerSeat,
              daysRemaining,
              daysInPeriod,
            },
          });

          if (addedCredits) {
            logger.info(
              `Added ${addedCredits} prorated credits to organization ${organization.id} for ${seatIncrease} new seats (${prorationFactor.toFixed(2)} proration factor)`
            );
          }
        }
        break;
      }

      case 'subscription_cycle': {
        // For updates and renewals, always use existing organization by customer ID
        organization = await organizationRepository.findByStripeCustomerId(customerId);
        if (!organization) {
          logger.debug(`No organization found for customer ID: ${customerId}`);
          return;
        }

        // Idempotency: skip if already processed this invoice
        const existing = await creditTransactionRepository.findByPaymentIntentId(idempotencyKey);
        if (existing) {
          logger.info(`subscription_cycle already processed for idempotencyKey ${idempotencyKey}, skipping`);
          break;
        }

        const creditsToAdd = subscriptionQuantity * ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT;
        const addedCredits = await addOrganizationCredits({
          organization,
          creditsToAdd,
          userId: metadata.userId,
          paymentIntentId,
          invoiceId: invoice.id,
          metadata: {
            type: 'subscription_renewal',
            seats: subscriptionQuantity,
            billingPeriodStart: periodStart,
            billingPeriodEnd: periodEnd,
          },
        });

        if (addedCredits) {
          logger.info(
            `Added ${addedCredits} renewal credits to organization ${organization.id} for ${subscriptionQuantity} seats`
          );
        }
        break;
      }
    }
  });

  // Notify clients OUTSIDE the transaction to avoid "Transaction already committed" errors.
  // sendToClient calls Connection.find() which, with transactionAsyncLocalStorage enabled,
  // would pick up the transaction session if called inside withTransaction.
  const org = organization as IOrganizationDocument | null;
  if (org?.users?.length) {
    promises.push(
      ...org.users.map(user =>
        sendToClient(user.userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['subscriptions'],
        })
      )
    );
  }

  promises.push(
    sendToClient(metadata.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['subscriptions'],
    }),
    sendToClient(metadata.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['organizations'],
    })
  );

  await Promise.all(promises);
};

/**
 * Handle invoice payment for user subscriptions
 * Creates subscription records and adds credits for individual user subscriptions
 */
export const handleUserSubscriptionInvoice = async (
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  metadata: SubscriptionMetadata,
  logger: Logger
) => {
  if (metadata.ownerType !== undefined && metadata.ownerType !== SubscriptionOwnerType.User) {
    logger.debug(`Ignoring non-user subscription: ${subscription.id}`);
    return;
  }

  if (!invoice.customer) {
    logger.error(`Invoice without customer: ${invoice.id}`);
    return;
  }

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id;
  const user = await userRepository.findByStripeCustomerId(customerId);

  if (!user) {
    logger.debug(`No user found with stripe customer ID: ${customerId}`);
    return;
  }

  const [item] = subscription.items.data;
  const planDetail = SUBSCRIPTION_PLANS.find(plan => plan.priceId === item.price.id);

  if (!planDetail) {
    // A miss here means a PAID invoice grants no subscription and no credits, so it must
    // never be a silent debug no-op. Historical root cause: the NEXT_PUBLIC_STRIPE_PRICE_*
    // env vars were missing from the event-bus Lambda env, so every configured priceId
    // evaluated to '' and nothing matched.
    logger.error(
      `Unknown plan for paid invoice ${invoice.id}: price ${item.price.id} matched no SUBSCRIPTION_PLANS entry — subscription/credits NOT applied`
    );
    await emitMetric('Lumina5/Entitlements', 'EntitlementSkipped', 1, { reason: 'unknown_plan' });
    return;
  }

  let credits = 0;

  // In v22+, invoice.payment_intent was removed; extract from invoice.payments
  const paymentIntentId =
    (invoice.payments?.data[0]?.payment?.type === 'payment_intent'
      ? typeof invoice.payments.data[0].payment.payment_intent === 'string'
        ? invoice.payments.data[0].payment.payment_intent
        : invoice.payments.data[0].payment.payment_intent?.id
      : undefined) ?? '';

  // Use invoice.id as fallback when paymentIntentId is empty (e.g. non-card payment methods).
  // An empty paymentIntentId bypasses BOTH the application pre-check and the DB sparse unique
  // index, allowing unlimited credit duplication on Stripe retries (up to ~15 over 3 days).
  const idempotencyKey = paymentIntentId || invoice.id;

  await withTransaction(async () => {
    switch (invoice.billing_reason) {
      case 'subscription_create': {
        // Do not create a new subscription record if it already exists
        const existingSubscription = await subscriptionRepository.findByStripeSubscriptionId(subscription.id);
        if (existingSubscription) {
          logger.debug(`Subscription already exists for user ${user.id}: ${subscription.id}`);
          break;
        }

        await subscriptionRepository.create({
          ownerType: SubscriptionOwnerType.User,
          ownerId: user.id,
          subscriptionId: subscription.id,
          priceId: item.price.id,
          status: subscription.status,
          source: SubscriptionSource.Stripe,
          periodStartsAt: dayjs.unix(item.current_period_start).toDate(),
          periodEndsAt: dayjs.unix(item.current_period_end).toDate(),
          canceledAt: null,
          quantity: 1, // Always 1 for user subscriptions
        });

        // Cooldown: prevent credit farming via cancel + re-subscribe within 72h
        const COOLDOWN_HOURS = 72;
        const cooldownMs = COOLDOWN_HOURS * 60 * 60 * 1000;
        if (user.lastCreditGrantAt && Date.now() - new Date(user.lastCreditGrantAt).getTime() < cooldownMs) {
          logger.warn(
            `Credit grant cooldown active for user ${user.id}, skipping credit grant (lastCreditGrantAt: ${user.lastCreditGrantAt})`
          );
          break; // Subscription still activates - only credit grant is skipped
        }

        credits = planDetail.credits;
        try {
          await creditService.addCredits(
            {
              ownerId: user.id,
              ownerType: CreditHolderType.User,
              credits: credits,
              type: 'subscription',
              metadata: {},
              stripePaymentIntentId: idempotencyKey,
            },
            {
              db: {
                creditTransactions: creditTransactionRepository,
              },
              creditHolderMethods: userRepository,
            }
          );
        } catch (err: unknown) {
          // Idempotency: E11000 = duplicate idempotencyKey - already processed, skip silently
          if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000) {
            logger.info(`Duplicate subscription_create webhook for user ${user.id}, skipping credit grant`);
            break;
          }
          throw err;
        }

        // Record grant timestamp for cooldown enforcement on future re-subscribes
        await userRepository.update({ id: user.id, lastCreditGrantAt: new Date() });

        logger.info(`Created user subscription and added ${credits} credits for user ${user.email}`);
        break;
      }

      case 'subscription_update':
      case 'subscription_cycle': {
        // Idempotency: skip if already processed this invoice
        const existing = await creditTransactionRepository.findByPaymentIntentId(idempotencyKey);
        if (existing) {
          logger.info(`subscription_cycle already processed for idempotencyKey ${idempotencyKey}, skipping`);
          break;
        }

        // Add credits for subscription renewal or update
        credits = planDetail.credits;
        try {
          await creditService.addCredits(
            {
              ownerId: user.id,
              ownerType: CreditHolderType.User,
              credits: credits,
              type: 'subscription',
              metadata: {},
              stripePaymentIntentId: idempotencyKey,
            },
            {
              db: {
                creditTransactions: creditTransactionRepository,
              },
              creditHolderMethods: userRepository,
            }
          );
        } catch (err: unknown) {
          // E11000: concurrent webhook retry already committed this transaction - treat as success
          if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000) {
            logger.info(
              `subscription_cycle duplicate key (E11000) for idempotencyKey ${idempotencyKey} — idempotent no-op`
            );
            break;
          }
          throw err;
        }

        logger.info(`Added ${credits} credits to user ${user.email}`);
        break;
      }
    }
  });

  await sendToClient(metadata.userId, Resource.websocket.managementEndpoint, {
    action: 'invalidate_query',
    queryKey: ['subscriptions'],
  });
};
