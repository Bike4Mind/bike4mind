import { describe, expect, it } from 'vitest';
import type { FulfillmentEvidence, FulfillmentLedgerRow } from '@client/app/utils/paymentFulfillment';
import { classifyPayment } from './classify';

const now = new Date('2026-11-10T00:00:00Z');
const old = '2026-11-01T00:00:00Z';
const recent = '2026-11-09T23:00:00Z';
const grant: FulfillmentLedgerRow = {
  id: 'tx1',
  type: 'purchase',
  ownerId: 'u1',
  ownerType: 'User',
  credits: 100,
  createdAt: old,
  status: 'completed',
};
const evidence = (patch: Partial<FulfillmentEvidence> = {}): FulfillmentEvidence => ({
  id: 'pi_1',
  createdAt: old,
  settledAt: old,
  amount: 1000,
  currency: 'usd',
  livemode: false,
  succeeded: true,
  expectedCredits: 100,
  owner: { id: 'u1', type: 'User' },
  product: 'credit_pack',
  rows: [grant],
  refunds: [],
  dispute: null,
  complete: true,
  ...patch,
});
const state = (patch: Partial<FulfillmentEvidence>) => classifyPayment(evidence(patch), now).state;

describe('payment fulfillment evidence', () => {
  it('is deterministic across retries and resolves delayed issuance on the next read', () => {
    expect(state({ rows: [] })).toBe('unmatched');
    expect(classifyPayment(evidence(), now)).toEqual(classifyPayment(evidence(), now));
    expect(state({})).toBe('consistent');
    expect(state({ rows: [], settledAt: recent })).toBe('pending');
  });
  it('uses stable IDs rather than event order or number of webhook deliveries', () => {
    expect(state({ rows: [grant, { ...grant, id: 'tx2' }] })).toBe('unknown');
    expect(state({ rows: [{ ...grant, ownerId: 'other' }] })).toBe('unmatched');
    expect(state({ rows: [{ ...grant, credits: 99 }] })).toBe('unmatched');
    expect(state({ rows: [{ ...grant, status: 'pending' }] })).toBe('unmatched');
  });
  it('does not guess historical subscription or organization grant amounts', () => {
    expect(state({ product: 'subscription', expectedCredits: null, rows: [] })).toBe('unknown');
    expect(
      state({
        product: 'subscription',
        expectedCredits: null,
        owner: { id: 'o1', type: 'Organization' },
        rows: [{ ...grant, type: 'subscription', ownerId: 'o1', ownerType: 'Organization' }],
      })
    ).toBe('unknown');
    expect(state({ owner: null })).toBe('unknown');
    expect(state({ complete: false })).toBe('unknown');
  });
  it('checks each partial refund independently and handles out-of-order deductions', () => {
    const refund = { id: 're_1', amount: 250, status: 'succeeded', createdAt: old };
    const deduction = { ...grant, id: 'tx2', type: 'generic_deduct', credits: -25, stripeRefundId: 're_1' };
    expect(state({ refunds: [refund] })).toBe('reversal');
    expect(state({ refunds: [{ ...refund, createdAt: recent }] })).toBe('pending');
    expect(state({ refunds: [refund], rows: [deduction, grant] })).toBe('consistent');
    expect(state({ refunds: [refund], rows: [grant, { ...deduction, credits: -24 }] })).toBe('reversal');
    expect(state({ refunds: [refund], rows: [grant, { ...deduction, type: 'generic_add' }] })).toBe('reversal');
  });
  it('requires the full refund reversal marker, not for a partial refund', () => {
    const refund = { id: 're_1', amount: 1000, status: 'succeeded', createdAt: old };
    const deduction = { ...grant, id: 'tx2', type: 'generic_deduct', credits: -100, stripeRefundId: 're_1' };
    expect(state({ refunds: [refund], rows: [grant, deduction] })).toBe('reversal');
    expect(state({ refunds: [refund], rows: [{ ...grant, reversedAt: old }, deduction] })).toBe('consistent');
  });
  it.each(['needs_response', 'under_review', 'lost'])('keeps %s disputes out of all-clear', status => {
    expect(state({ dispute: { id: 'dp_1', status, createdAt: old } })).toBe('reversal');
  });
  it('does not demand credits for unsuccessful payments or failed refunds', () => {
    expect(state({ succeeded: false, rows: [] })).toBe('pending');
    expect(state({ refunds: [{ id: 're_1', amount: 1000, status: 'failed', createdAt: old }] })).toBe('consistent');
  });
});
