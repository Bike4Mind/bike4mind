import type Stripe from 'stripe';
import type { Logger } from '@bike4mind/observability';
import { requireEnv } from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { ISubscription, SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';
import {
  buildCanceledForNonPaymentEmail,
  buildPaymentActionRequiredEmail,
  buildPaymentFailedEmail,
  buildUnpaidEmail,
  type EmailContent,
} from '@server/utils/mailer/paymentFailedEmail';

/**
 * Owner-facing billing emails for Stripe dunning. These replace Stripe's own failed-payment
 * emails, which must be switched off in the Stripe Dashboard when this ships so owners do not
 * get both.
 */

interface OwnerRecipient {
  /** For an org subscription, the org owner's address. */
  email: string;
  organizationName: string | null;
  billingUrl: string;
}

/**
 * The person who can fix the card. For an org that is the owner (`organization.userId`), not
 * every member: the Billing tab is owner-only (app/routes/organizations/orgTabAccess.ts), so the
 * link would not work for anyone else.
 */
export async function resolveOwnerRecipient(
  subscription: Pick<ISubscription, 'ownerType' | 'ownerId'>
): Promise<OwnerRecipient | null> {
  const appUrl = requireEnv('APP_URL', process.env.APP_URL);

  if (subscription.ownerType === SubscriptionOwnerType.Organization) {
    const organization = await organizationRepository.findById(subscription.ownerId);
    if (!organization?.userId) return null;
    const owner = await userRepository.findById(organization.userId);
    if (!owner?.email) return null;
    return {
      email: owner.email,
      organizationName: organization.name ?? null,
      billingUrl: `${appUrl}/organizations/${organization.id}?tab=billing`,
    };
  }

  const user = await userRepository.findById(subscription.ownerId);
  if (!user?.email) return null;
  // `/billing/plans`, not `/?billing=plans`: only the former survives a sign-in redirect
  // (app/utils/billingDeepLink.ts).
  return { email: user.email, organizationName: null, billingUrl: `${appUrl}/billing/plans` };
}

/**
 * The invoice's latest payment intent. This API version carries no intent on the invoice itself,
 * so it comes from the expanded `payments` list. Best effort: null when Stripe cannot be reached.
 */
async function getLatestPaymentIntent(invoiceId: string, logger: Logger): Promise<Stripe.PaymentIntent | null> {
  try {
    const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payments.data.payment.payment_intent'] });
    const latest = [...(invoice.payments?.data ?? [])].sort((a, b) => b.created - a.created)[0];
    const intent = latest?.payment.payment_intent;
    return !intent || typeof intent === 'string' ? null : intent;
  } catch (error) {
    logger.warn(`Could not read the payment intent for invoice ${invoiceId}`, { error });
    return null;
  }
}

/** The card issuer's message for the invoice's latest failed payment; a lookup failure drops it. */
export async function getInvoiceFailureReason(invoiceId: string, logger: Logger): Promise<string | null> {
  return (await getLatestPaymentIntent(invoiceId, logger))?.last_payment_error?.message ?? null;
}

/** The bank wants the customer to confirm, which `invoice.payment_action_required` already emails about. */
function needsAuthentication(intent: Stripe.PaymentIntent | null): boolean {
  return intent?.status === 'requires_action' || intent?.last_payment_error?.code === 'authentication_required';
}

type NoticeKind = 'payment_failed' | 'canceled_for_non_payment' | 'payment_action_required' | 'unpaid';

/**
 * Send one notice under a claim, best effort: nothing here throws. The webhook must not answer
 * 500 for an email, because Stripe would then redeliver the whole event and repeat its Slack post
 * and invoice cleanup. The claim is taken before any lookup, so a retry of an already-sent notice
 * costs one write; a failure releases it, so the next `invoice.payment_failed` for the same
 * invoice (Stripe's next retry) can still send it.
 */
async function sendOnce(
  kind: NoticeKind,
  subscriptionId: string,
  claim: () => Promise<boolean>,
  release: () => Promise<void>,
  build: () => Promise<(EmailContent & { to: string }) | null>,
  logger: Logger
): Promise<boolean> {
  let claimed = false;
  try {
    claimed = await claim();
    if (!claimed) {
      logger.info(`Billing notice ${kind} for ${subscriptionId} already sent, skipping`);
      return false;
    }
    const email = await build();
    if (!email) {
      // The claim is kept: a retry would find no one to send to either.
      logger.warn(`No owner email for subscription ${subscriptionId}; billing notice ${kind} not sent`);
      return false;
    }
    await EmailEvents.Send.publish({ to: email.to, subject: email.subject, body: email.body });
    logger.info(`Sent billing notice ${kind} to the owner of ${subscriptionId}`);
    return true;
  } catch (error) {
    logger.error(`Failed to send billing notice ${kind} for ${subscriptionId}`, { error });
    await emitMetric('Lumina5/Billing', 'BillingNoticeFailed', 1, { kind });
    if (claimed) {
      try {
        await release();
      } catch (releaseError) {
        logger.warn(`Could not release the ${kind} claim for ${subscriptionId}; the notice will not retry`, {
          error: releaseError,
        });
      }
    }
    return false;
  }
}

/**
 * Email the owner that a renewal charge failed, once per invoice. Renewals only: a declined
 * proration (an org adding seats) or a one-off invoice is not "your renewal failed", and the
 * first invoice fails inside checkout, where the user already sees the error. Resolves true only
 * when this call sent the email.
 */
export async function notifyPaymentFailed(
  subscription: ISubscription,
  invoice: Pick<Stripe.Invoice, 'id' | 'next_payment_attempt' | 'billing_reason'>,
  logger: Logger
): Promise<boolean> {
  const subscriptionId = subscription.subscriptionId;
  if (!subscriptionId) return false;
  if (invoice.billing_reason !== 'subscription_cycle') {
    logger.debug(`Invoice ${invoice.id} is ${invoice.billing_reason}, not a renewal; no payment-failed email`);
    return false;
  }

  // Stripe sends invoice.payment_failed alongside invoice.payment_action_required for a renewal
  // that needs 3DS; the confirm-payment email is the only one that applies. A failed lookup
  // yields no intent, so this fails open toward sending.
  const intent = await getLatestPaymentIntent(invoice.id, logger);
  if (needsAuthentication(intent)) {
    logger.info(`Invoice ${invoice.id} needs authentication; leaving it to the confirm-payment email`);
    return false;
  }

  return sendOnce(
    'payment_failed',
    subscriptionId,
    () => subscriptionRepository.claimPaymentFailureNotice(subscriptionId, invoice.id),
    () => subscriptionRepository.releasePaymentFailureNotice(subscriptionId, invoice.id),
    async () => {
      const recipient = await resolveOwnerRecipient(subscription);
      if (!recipient) return null;
      const content = buildPaymentFailedEmail({
        billingUrl: recipient.billingUrl,
        failureReason: intent?.last_payment_error?.message ?? null,
        nextAttemptAt: invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null,
        organizationName: recipient.organizationName,
      });
      return { to: recipient.email, ...content };
    },
    logger
  );
}

/** Email the owner, once, that dunning ended by cancelling the subscription. */
export async function notifyCanceledForNonPayment(subscription: ISubscription, logger: Logger): Promise<void> {
  const subscriptionId = subscription.subscriptionId;
  if (!subscriptionId) return;

  await sendOnce(
    'canceled_for_non_payment',
    subscriptionId,
    () => subscriptionRepository.claimNonPaymentCancelNotice(subscriptionId),
    () => subscriptionRepository.releaseNonPaymentCancelNotice(subscriptionId),
    async () => {
      const recipient = await resolveOwnerRecipient(subscription);
      if (!recipient) return null;
      const content = buildCanceledForNonPaymentEmail({
        billingUrl: recipient.billingUrl,
        organizationName: recipient.organizationName,
      });
      return { to: recipient.email, ...content };
    },
    logger
  );
}

/**
 * Email the owner, once per invoice, that the bank needs them to confirm a renewal payment.
 * Renewals only, for the same reason as notifyPaymentFailed: the copy is wrong for a proration
 * or a one-off invoice. Resolves true only when this call sent it.
 */
export async function notifyPaymentActionRequired(
  subscription: ISubscription,
  invoice: Pick<Stripe.Invoice, 'id' | 'billing_reason'>,
  logger: Logger
): Promise<boolean> {
  const subscriptionId = subscription.subscriptionId;
  if (!subscriptionId || !invoice.id) return false;
  if (invoice.billing_reason !== 'subscription_cycle') {
    logger.debug(`Invoice ${invoice.id} is ${invoice.billing_reason}, not a renewal; no confirm-payment email`);
    return false;
  }
  const key = `payment_action_required:${invoice.id}`;

  return sendOnce(
    'payment_action_required',
    subscriptionId,
    () => subscriptionRepository.claimBillingNotice(subscriptionId, key),
    () => subscriptionRepository.releaseBillingNotice(subscriptionId, key),
    async () => {
      const recipient = await resolveOwnerRecipient(subscription);
      if (!recipient) return null;
      const content = buildPaymentActionRequiredEmail({
        billingUrl: recipient.billingUrl,
        organizationName: recipient.organizationName,
      });
      return { to: recipient.email, ...content };
    },
    logger
  );
}

const unpaidKey = (subscriptionId: string) => `unpaid:${subscriptionId}`;

/**
 * Email the owner, once per unpaid spell, that dunning ended by marking the subscription unpaid.
 * An unpaid subscription keeps getting a new invoice each period, so the claim is on the
 * subscription and is only released by clearUnpaidNotice when it leaves `unpaid`.
 */
export async function notifyUnpaid(subscription: ISubscription, logger: Logger): Promise<boolean> {
  const subscriptionId = subscription.subscriptionId;
  if (!subscriptionId) return false;
  const key = unpaidKey(subscriptionId);

  return sendOnce(
    'unpaid',
    subscriptionId,
    () => subscriptionRepository.claimBillingNotice(subscriptionId, key),
    () => subscriptionRepository.releaseBillingNotice(subscriptionId, key),
    async () => {
      const recipient = await resolveOwnerRecipient(subscription);
      if (!recipient) return null;
      const content = buildUnpaidEmail({
        billingUrl: recipient.billingUrl,
        organizationName: recipient.organizationName,
      });
      return { to: recipient.email, ...content };
    },
    logger
  );
}

/** Re-arm the unpaid notice once a subscription is out of `unpaid`, so a later spell notifies again. Never throws. */
export async function clearUnpaidNotice(subscriptionId: string, logger: Logger): Promise<void> {
  try {
    await subscriptionRepository.releaseBillingNotice(subscriptionId, unpaidKey(subscriptionId));
  } catch (error) {
    logger.warn(`Could not clear the unpaid notice for ${subscriptionId}`, { error });
  }
}
