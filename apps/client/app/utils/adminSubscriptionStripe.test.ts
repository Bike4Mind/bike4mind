import { describe, expect, it } from 'vitest';
import {
  AdminSubscriptionStripeParamsSchema,
  cardExpiresWithinDays,
  invoicePaymentKey,
} from './adminSubscriptionStripe';

const intent = (payment_intent: string | { id: string } | null) => ({
  id: 'in_1',
  payments: { data: [{ payment: { type: 'payment_intent', payment_intent } }] },
});

describe('invoicePaymentKey', () => {
  it('uses the payment intent id, string or expanded', () => {
    expect(invoicePaymentKey(intent('pi_1'))).toBe('pi_1');
    expect(invoicePaymentKey(intent({ id: 'pi_2' }))).toBe('pi_2');
  });

  it('falls back to the invoice id for non-card payments or none', () => {
    expect(invoicePaymentKey({ id: 'in_1', payments: { data: [{ payment: { type: 'charge' } }] } })).toBe('in_1');
    expect(invoicePaymentKey({ id: 'in_1', payments: { data: [] } })).toBe('in_1');
    expect(invoicePaymentKey({ id: 'in_1' })).toBe('in_1');
    expect(invoicePaymentKey(intent(null))).toBe('in_1');
  });
});

describe('cardExpiresWithinDays', () => {
  const now = Date.UTC(2026, 10, 4);

  it('is true inside the window and false outside it', () => {
    expect(cardExpiresWithinDays({ expMonth: 11, expYear: 2026 }, now)).toBe(true);
    expect(cardExpiresWithinDays({ expMonth: 12, expYear: 2026 }, now)).toBe(false);
  });

  it('is false for a past card or a missing expiry', () => {
    expect(cardExpiresWithinDays({ expMonth: 10, expYear: 2026 }, now)).toBe(false);
    expect(cardExpiresWithinDays({ expMonth: null, expYear: null }, now)).toBe(false);
    expect(cardExpiresWithinDays(null, now)).toBe(false);
  });
});

describe('AdminSubscriptionStripeParamsSchema', () => {
  it('accepts an ObjectId and a fresh flag', () => {
    expect(AdminSubscriptionStripeParamsSchema.parse({ id: 'a'.repeat(24), fresh: '1' })).toEqual({
      id: 'a'.repeat(24),
      fresh: true,
    });
    expect(AdminSubscriptionStripeParamsSchema.parse({ id: 'a'.repeat(24) }).fresh).toBe(false);
  });

  it('rejects anything else', () => {
    expect(AdminSubscriptionStripeParamsSchema.safeParse({ id: 'nope' }).success).toBe(false);
  });
});
