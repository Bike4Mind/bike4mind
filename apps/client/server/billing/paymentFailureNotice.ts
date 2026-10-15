import type Stripe from 'stripe';
import type { Logger } from '@bike4mind/observability';
import { requireEnv } from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { ISubscription, SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { stripe } from '@server/integrations/stripe/stripe';
import { subscriptionRepository } from '@server/models/Subscription';
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

/**
 * Publish one email under a claim. The claim is taken only once there is someone to send to, and
 * released when the publish fails so the rethrown error's Stripe redelivery can send it.
 */
async function sendClaimed(
  email: string,
  content: EmailContent,
  claim: () => Promise<boolean>,
  release: () => Promise<void>
): Promise<boolean> {
  if (!(await claim())) return false;
  try {
    await EmailEvents.Send.publish({ to: email, subject: content.subject, body: content.body });
  } catch (error) {
    await release();
    throw error;
  }
  return true;
}

/** Email the owner that a renewal charge failed, once per invoice. */
export async function notifyPaymentFailed(
  subscription: ISubscription,
  invoice: Pick<Stripe.Invoice, 'id' | 'next_payment_attempt'>,
  logger: Logger
): Promise<void> {
  const subscriptionId = subscription.subscriptionId;
  if (!subscriptionId) return;

  const recipient = await resolveOwnerRecipient(subscription);
  if (!recipient) {
    logger.warn(`No owner email for subscription ${subscriptionId}; payment-failed email not sent`);
    return;
  }

  const content = buildPaymentFailedEmail({
    billingUrl: recipient.billingUrl,
    failureReason: await getInvoiceFailureReason(invoice.id, logger),
    nextAttemptAt: invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null,
    organizationName: recipient.organizationName,
  });

  const sent = await sendClaimed(
    recipient.email,
    content,
    () => subscriptionRepository.claimPaymentFailureNotice(subscriptionId, invoice.id),
    () => subscriptionRepository.releasePaymentFailureNotice(subscriptionId, invoice.id)
  );
  logger.info(
    sent
      ? `Sent payment-failed email for invoice ${invoice.id} to the owner of ${subscriptionId}`
      : `Payment-failed email for invoice ${invoice.id} already sent, skipping`
  );
}

/** Email the owner, once, that dunning ended by cancelling the subscription. */
export async function notifyCanceledForNonPayment(subscription: ISubscription, logger: Logger): Promise<void> {
  const subscriptionId = subscription.subscriptionId;
  if (!subscriptionId) return;

  const recipient = await resolveOwnerRecipient(subscription);
  if (!recipient) {
    logger.warn(`No owner email for subscription ${subscriptionId}; cancellation email not sent`);
    return;
  }

  const sent = await sendClaimed(
    recipient.email,
    buildCanceledForNonPaymentEmail({
      billingUrl: recipient.billingUrl,
      organizationName: recipient.organizationName,
    }),
    () => subscriptionRepository.claimNonPaymentCancelNotice(subscriptionId),
    () => subscriptionRepository.releaseNonPaymentCancelNotice(subscriptionId)
  );
  logger.info(
    sent
      ? `Sent cancelled-for-non-payment email to the owner of ${subscriptionId}`
      : `Cancelled-for-non-payment email for ${subscriptionId} already sent, skipping`
  );
}
