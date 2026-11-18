import type Stripe from 'stripe';
import { CreditTransaction, organizationRepository, userRepository } from '@bike4mind/database';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { Config } from '@bike4mind/server-utils/utils/config';
import type { FulfillmentEvidence, FulfillmentLedgerRow } from '@client/app/utils/paymentFulfillment';

type LedgerRow = Omit<FulfillmentLedgerRow, 'id' | 'createdAt' | 'reversedAt'> & {
  _id: { toString(): string };
  createdAt: Date;
  reversedAt?: Date | null;
};

export async function invoiceEvidence(invoice: Stripe.Invoice): Promise<FulfillmentEvidence | null> {
  const stage = invoice.parent?.subscription_details?.metadata?.stage;
  if (stage && stage !== Config.STAGE) return null;
  const subscriptionRef = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof subscriptionRef === 'string' ? subscriptionRef : subscriptionRef?.id;
  if (!subscriptionId) return null;
  const subscription = await subscriptionRepository.findByStripeSubscriptionId(subscriptionId);
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const [user, organization] = customerId
    ? await Promise.all([
        userRepository.findByStripeCustomerId(customerId),
        organizationRepository.findByStripeCustomerId(customerId),
      ])
    : [null, null];
  if (stage !== Config.STAGE && !subscription && !user && !organization) return null;
  const owner =
    user && !organization
      ? { id: user.id, type: 'User' as const }
      : organization && !user
        ? { id: organization.id, type: 'Organization' as const }
        : null;
  const payments = await stripe.invoicePayments.list({ invoice: invoice.id, limit: 100 });
  const paymentIntentIds = [
    ...new Set(
      payments.data.flatMap(payment => {
        const ref = payment.payment.payment_intent;
        return payment.payment.type === 'payment_intent' && ref ? [typeof ref === 'string' ? ref : ref.id] : [];
      })
    ),
  ];
  const chargeRefs = payments.data.flatMap(payment => {
    const ref = payment.payment.charge;
    return payment.payment.type === 'charge' && ref ? [typeof ref === 'string' ? ref : ref.id] : [];
  });
  const intents = await Promise.all(
    paymentIntentIds.slice(0, 2).map(id => stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] }))
  );
  const charges = [
    ...intents.flatMap(intent =>
      intent.latest_charge && typeof intent.latest_charge !== 'string' ? [intent.latest_charge] : []
    ),
    ...(await Promise.all(chargeRefs.slice(0, 2).map(id => stripe.charges.retrieve(id)))),
  ];
  const refunds = await Promise.all(
    charges
      .filter(charge => charge.amount_refunded > 0)
      .map(charge => stripe.refunds.list({ charge: charge.id, limit: 100 }))
  );
  const disputes = await Promise.all(
    charges.filter(charge => charge.disputed).map(charge => stripe.disputes.list({ charge: charge.id, limit: 2 }))
  );
  const refundRows = refunds.flatMap(page => page.data);
  const disputeRows = disputes.flatMap(page => page.data);
  const rows = await CreditTransaction.find({
    $or: [
      { stripePaymentIntentId: { $in: [invoice.id, ...paymentIntentIds] } },
      ...(refundRows.length ? [{ stripeRefundId: { $in: refundRows.map(refund => refund.id) } }] : []),
      ...(disputeRows.length ? [{ stripeDisputeId: { $in: disputeRows.map(dispute => dispute.id) } }] : []),
    ],
  })
    .select(
      'type ownerId ownerType credits createdAt status stripeRefundId stripeDisputeId reversedAt stripePaymentIntentId'
    )
    .limit(102)
    .maxTimeMS(3000)
    .lean<LedgerRow[]>();
  const subscriptionOwnerMatches =
    subscription && owner && subscription.ownerId === owner.id && subscription.ownerType === owner.type;
  const paidAt = invoice.status_transitions.paid_at;
  return {
    id: invoice.id,
    createdAt: new Date(invoice.created * 1000).toISOString(),
    settledAt: paidAt ? new Date(paidAt * 1000).toISOString() : null,
    amount: invoice.amount_paid,
    currency: invoice.currency,
    livemode: invoice.livemode,
    succeeded: invoice.status === 'paid',
    product: 'subscription',
    expectedCredits: null,
    owner,
    invoice: {
      id: invoice.id,
      subscriptionId,
      subscriptionRecordId: subscription?.id ?? null,
      billingReason: invoice.billing_reason,
      paymentIntentIds,
      expectsGrant: Boolean(
        subscriptionOwnerMatches &&
        invoice.billing_reason === 'subscription_cycle' &&
        invoice.lines.data.some(line => (line.quantity ?? 0) > 0)
      ),
    },
    rows: rows.map(row => ({
      ...row,
      id: row._id.toString(),
      createdAt: row.createdAt.toISOString(),
      reversedAt: row.reversedAt?.toISOString(),
    })),
    refunds: refundRows.map(refund => ({
      id: refund.id,
      amount: refund.amount,
      status: refund.status,
      createdAt: new Date(refund.created * 1000).toISOString(),
    })),
    dispute: disputeRows[0]
      ? {
          id: disputeRows[0].id,
          status: disputeRows[0].status,
          createdAt: new Date(disputeRows[0].created * 1000).toISOString(),
        }
      : null,
    complete:
      !payments.has_more &&
      !invoice.lines.has_more &&
      rows.length < 102 &&
      (invoice.amount_paid === 0 || charges.length > 0) &&
      payments.data.length <= 1 &&
      paymentIntentIds.length + chargeRefs.length <= 1 &&
      charges.length === paymentIntentIds.length + chargeRefs.length &&
      payments.data.every(payment => payment.payment.type === 'payment_intent' || payment.payment.type === 'charge') &&
      !refunds.some(page => page.has_more) &&
      !disputes.some(page => page.has_more) &&
      disputeRows.length <= 1,
  };
}
