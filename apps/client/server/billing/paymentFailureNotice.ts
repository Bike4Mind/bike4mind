import type Stripe from 'stripe';
import type { Logger } from '@bike4mind/observability';
import { requireEnv } from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { ISubscription, SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { stripe } from '@server/integrations/stripe/stripe';
import { subscriptionRepository } from '@server/models/Subscription';
import { emitMetric } from '@server/utils/cloudwatch';
import { EmailEvents } from '@server/utils/eventBus';
import {
  buildCanceledForNonPaymentEmail,
  buildPaymentFailedEmail,
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
 * The card issuer's message for the invoice's latest failed payment. The invoice itself carries
 * no payment intent on this API version, so it comes from the expanded `payments` list. Best
 * effort: a lookup failure only drops the reason line from the email.
 */
export async function getInvoiceFailureReason(invoiceId: string, logger: Logger): Promise<string | null> {
  try {
    const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payments.data.payment.payment_intent'] });
    const latest = [...(invoice.payments?.data ?? [])].sort((a, b) => b.created - a.created)[0];
    const intent = latest?.payment.payment_intent;
    if (!intent || typeof intent === 'string') return null;
    return intent.last_payment_error?.message ?? null;
  } catch (error) {
    logger.warn(`Could not read the failure reason for invoice ${invoiceId}`, { error });
    return null;
  }
}

type NoticeKind = 'payment_failed' | 'canceled_for_non_payment';

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
): Promise<void> {
  let claimed = false;
  try {
    claimed = await claim();
    if (!claimed) {
      logger.info(`Billing notice ${kind} for ${subscriptionId} already sent, skipping`);
      return;
    }
    const email = await build();
    if (!email) {
      // The claim is kept: a retry would find no one to send to either.
      logger.warn(`No owner email for subscription ${subscriptionId}; billing notice ${kind} not sent`);
      return;
    }
    await EmailEvents.Send.publish({ to: email.to, subject: email.subject, body: email.body });
    logger.info(`Sent billing notice ${kind} to the owner of ${subscriptionId}`);
  } catch (error) {
    logger.error(`Failed to send billing notice ${kind} for ${subscriptionId}`, { error });
    await emitMetric('Lumina5/Billing', 'BillingNoticeFailed', 1, { kind });
    if (!claimed) return;
    try {
      await release();
    } catch (releaseError) {
      logger.warn(`Could not release the ${kind} claim for ${subscriptionId}; the notice will not retry`, {
        error: releaseError,
      });
    }
  }
}

/**
 * Email the owner that a renewal charge failed, once per invoice. Renewals only: a declined
 * proration (an org adding seats) or a one-off invoice is not "your renewal failed", and the
 * first invoice fails inside checkout, where the user already sees the error.
 */
export async function notifyPaymentFailed(
  subscription: ISubscription,
  invoice: Pick<Stripe.Invoice, 'id' | 'next_payment_attempt' | 'billing_reason'>,
  logger: Logger
): Promise<void> {
  const subscriptionId = subscription.subscriptionId;
  if (!subscriptionId) return;
  if (invoice.billing_reason !== 'subscription_cycle') {
    logger.debug(`Invoice ${invoice.id} is ${invoice.billing_reason}, not a renewal; no payment-failed email`);
    return;
  }

  await sendOnce(
    'payment_failed',
    subscriptionId,
    () => subscriptionRepository.claimPaymentFailureNotice(subscriptionId, invoice.id),
    () => subscriptionRepository.releasePaymentFailureNotice(subscriptionId, invoice.id),
    async () => {
      const recipient = await resolveOwnerRecipient(subscription);
      if (!recipient) return null;
      const content = buildPaymentFailedEmail({
        billingUrl: recipient.billingUrl,
        failureReason: await getInvoiceFailureReason(invoice.id, logger),
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
