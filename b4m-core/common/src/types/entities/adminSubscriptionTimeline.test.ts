import { describe, expect, it } from 'vitest';
import { billingEventSummary } from './adminSubscriptionTimeline';

describe('billingEventSummary', () => {
  it.each([
    ['customer.subscription.created', {}, 'Subscription created'],
    ['invoice.payment_succeeded', { billingReason: 'subscription_cycle' }, 'Renewed'],
    ['invoice.payment_succeeded', { billingReason: 'subscription_create' }, 'First payment'],
    ['invoice.payment_succeeded', {}, 'Payment succeeded'],
    ['invoice.payment_failed', { attemptCount: 2 }, 'Payment failed (attempt 2)'],
    [
      'invoice.payment_failed',
      { attemptCount: 1, dunningNoticeSent: true },
      'Payment failed (attempt 1), dunning email sent',
    ],
    ['customer.subscription.deleted', {}, 'Subscription canceled'],
    ['charge.refunded', {}, 'Refunded'],
    ['charge.dispute.created', {}, 'Disputed'],
    ['charge.dispute.closed', { status: 'won' }, 'Dispute won'],
    ['charge.dispute.closed', { status: 'lost' }, 'Dispute closed (lost)'],
    ['invoice.upcoming', {}, 'invoice.upcoming'],
  ])('%s %j reads "%s"', (type, data, expected) => {
    expect(billingEventSummary(type, data)).toBe(expected);
  });

  it('names each change a subscription update carries', () => {
    expect(
      billingEventSummary('customer.subscription.updated', {
        priceId: 'price_team',
        previousPriceId: 'price_pro',
        quantity: 7,
        previousQuantity: 5,
      })
    ).toBe('Plan changed, Seats changed from 5 to 7');
    expect(
      billingEventSummary('customer.subscription.updated', {
        cancelAtPeriodEnd: true,
        previousCancelAtPeriodEnd: false,
      })
    ).toBe('Cancellation scheduled');
    expect(billingEventSummary('customer.subscription.updated', { status: 'past_due', previousStatus: 'active' })).toBe(
      'Status changed to past due'
    );
    expect(billingEventSummary('customer.subscription.updated', { status: 'active' })).toBe('Subscription updated');
  });
});
