import type { FulfillmentEvidence, FulfillmentFinding, FulfillmentState } from '@client/app/utils/paymentFulfillment';

export const SETTLEMENT_GRACE_MS = 72 * 60 * 60 * 1000;

export function classifyPayment(e: FulfillmentEvidence, now: Date): FulfillmentFinding {
  const finding = (state: FulfillmentState, explanation: string): FulfillmentFinding => ({ ...e, state, explanation });
  if (!e.complete) return finding('unknown', 'Provider or ledger evidence is incomplete.');
  if (!e.succeeded) return finding('pending', 'Provider payment has not succeeded; no issuance is inferred.');
  const grants = e.rows.filter(row => row.type === 'purchase' || row.type === 'subscription');
  if (grants.length > 1) return finding('duplicate', 'Multiple issuance rows share this stable payment identifier.');
  if (!e.owner) return finding('unknown', 'Payment ownership cannot be established in this environment.');
  if (grants.some(row => row.ownerId !== e.owner?.id || row.ownerType !== e.owner.type)) {
    return finding('unmatched', 'The issuance owner differs from the provider-linked owner.');
  }
  const withinGrace = (time: string) => now.getTime() - new Date(time).getTime() < SETTLEMENT_GRACE_MS;
  if (e.dispute && e.dispute.status !== 'won') {
    return finding('reversal', 'Dispute requires review; a payment match does not establish dispute settlement.');
  }
  for (const refund of e.refunds) {
    if (refund.status === 'failed' || refund.status === 'canceled') continue;
    if (refund.status !== 'succeeded') return finding('pending', 'Provider refund is still pending.');
    if (e.product !== 'credit_pack' || e.expectedCredits === null || e.amount <= 0) {
      return finding('unknown', 'Refund allocation cannot be inferred for this product.');
    }
    const expected = Math.round((e.expectedCredits * refund.amount) / e.amount);
    const deductions = e.rows.filter(row => row.stripeRefundId === refund.id);
    if (
      expected > 0 &&
      (deductions.length !== 1 ||
        deductions[0].type !== 'generic_deduct' ||
        Math.abs(deductions[0].credits) !== expected ||
        deductions[0].ownerId !== e.owner.id ||
        deductions[0].ownerType !== e.owner.type)
    ) {
      return finding(
        withinGrace(refund.createdAt) ? 'pending' : 'reversal',
        'Refund lacks a matching proportional credit deduction.'
      );
    }
  }
  if (
    e.refunds.filter(refund => refund.status === 'succeeded').reduce((sum, refund) => sum + refund.amount, 0) >=
      e.amount &&
    e.amount > 0 &&
    grants.length === 1 &&
    !grants[0].reversedAt
  ) {
    return finding('reversal', 'Fully refunded purchase has no local reversal marker.');
  }
  if (e.product !== 'credit_pack' || e.expectedCredits === null) {
    return finding(
      'unknown',
      'Subscription credits depend on historical plan, cooldown, custom cycle and seat rules; no amount is inferred.'
    );
  }
  if (!e.settledAt) return finding('unknown', 'Provider settlement time is unavailable.');
  if (grants.length === 0 || grants[0].status !== 'completed') {
    return finding(
      withinGrace(e.settledAt) ? 'pending' : 'unmatched',
      'Successful credit-pack payment lacks completed issuance.'
    );
  }
  if (grants[0].type !== 'purchase' || grants[0].credits !== e.expectedCredits) {
    return finding('unmatched', 'Issuance type or credits differ from the server-set payment metadata.');
  }
  return finding(
    'consistent',
    'Provider credit-pack metadata and the local issuance ledger agree; balance delivery is not independently verified.'
  );
}
