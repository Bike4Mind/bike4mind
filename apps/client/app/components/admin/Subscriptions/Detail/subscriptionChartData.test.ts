import { describe, expect, it } from 'vitest';
import type { AdminStripeInvoice } from '@client/app/utils/adminSubscriptionStripe';
import {
  MAX_PAYMENT_BARS,
  creditsTakeaway,
  paymentOutcome,
  paymentTakeaway,
  seatsTakeaway,
  toCreditCyclePoints,
  toPaymentHistory,
  toSeatPoints,
} from './subscriptionChartData';

const invoice = (overrides: Partial<AdminStripeInvoice> = {}): AdminStripeInvoice => ({
  id: 'in_1',
  number: 'N-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  amountDue: 1900,
  amountPaid: 1900,
  currency: 'usd',
  status: 'paid',
  paidAt: '2026-10-01T00:00:00.000Z',
  attempts: 1,
  hostedInvoiceUrl: null,
  creditsGranted: 1000,
  amountRefunded: 0,
  ...overrides,
});

describe('paymentOutcome', () => {
  it('tells paid, refunded, failed, open and void apart', () => {
    expect(paymentOutcome(invoice())).toBe('paid');
    expect(paymentOutcome(invoice({ amountRefunded: 500 }))).toBe('refunded');
    expect(paymentOutcome(invoice({ status: 'uncollectible' }))).toBe('failed');
    expect(paymentOutcome(invoice({ status: 'open', attempts: 2 }))).toBe('failed');
    expect(paymentOutcome(invoice({ status: 'open', attempts: 0 }))).toBe('open');
    expect(paymentOutcome(invoice({ status: 'void' }))).toBe('void');
  });
});

describe('toPaymentHistory', () => {
  it('orders oldest first, charts what was charged or asked for, and drops drafts', () => {
    const history = toPaymentHistory([
      invoice({ id: 'in_3', createdAt: '2026-12-01T00:00:00.000Z', status: 'open', amountPaid: 0, attempts: 1 }),
      invoice({ id: 'in_draft', status: 'draft' }),
      invoice({ id: 'in_2', createdAt: '2026-11-01T00:00:00.000Z', amountRefunded: 1900 }),
      invoice({ id: 'in_1' }),
    ]);
    expect(history.bars.map(bar => [bar.id, bar.amount, bar.outcome])).toEqual([
      ['in_1', 1900, 'paid'],
      ['in_2', 1900, 'refunded'],
      ['in_3', 1900, 'failed'],
    ]);
    expect(history).toMatchObject({ currency: 'usd', otherCurrencyCount: 0, olderCount: 0 });
  });

  it('charts only the latest invoice currency and caps the bars', () => {
    const many = Array.from({ length: MAX_PAYMENT_BARS + 2 }, (_, index) => invoice({ id: `in_${index}` }));
    const history = toPaymentHistory([...many, invoice({ id: 'in_eur', currency: 'eur' })]);
    expect(history.bars).toHaveLength(MAX_PAYMENT_BARS);
    expect(history.bars.at(-1)?.id).toBe('in_0');
    expect(history).toMatchObject({ currency: 'usd', otherCurrencyCount: 1, olderCount: 2 });
  });

  it('is empty with no invoices', () => {
    expect(toPaymentHistory([])).toEqual({ bars: [], currency: null, otherCurrencyCount: 0, olderCount: 0 });
  });
});

describe('paymentTakeaway', () => {
  it('counts outcomes and names the latest invoice', () => {
    const history = toPaymentHistory([
      invoice({ id: 'in_2', createdAt: '2026-11-01T00:00:00.000Z', status: 'uncollectible', amountDue: 1900 }),
      invoice({ id: 'in_1' }),
    ]);
    expect(paymentTakeaway(history)).toBe(
      '2 invoices since 1 Oct 2026: 1 paid, 1 failed. Latest: $19.00 failed on 1 Nov 2026.'
    );
  });
});

const cycle = (start: string, granted: number, used: number, current = false) => ({
  start: `${start}T00:00:00.000Z`,
  end: `${start}T00:00:00.000Z`,
  granted,
  used,
  current,
});

describe('creditsTakeaway', () => {
  it('reports the last full cycle and the running one', () => {
    const points = toCreditCyclePoints([
      cycle('2026-08-01', 1000, 900),
      cycle('2026-10-01', 1000, 1250),
      cycle('2026-11-01', 1000, 40, true),
    ]);
    expect(points[0].label).toBe('1 Aug 2026');
    expect(creditsTakeaway(points)).toBe(
      'The last full cycle used 1,250 of 1,000 credits granted (125%). This cycle has used 40 of 1,000 so far.'
    );
  });

  it('reads a first, still running cycle on its own', () => {
    expect(creditsTakeaway(toCreditCyclePoints([cycle('2026-11-01', 2000, 0, true)]))).toBe(
      'The first cycle has used 0 of 2,000 so far.'
    );
  });
});

describe('seat points', () => {
  const seats = { paid: 8, members: 6 };
  const changes = [
    { at: '2026-08-01T00:00:00.000Z', quantity: 5 },
    { at: '2026-10-01T00:00:00.000Z', quantity: 8 },
  ];

  it('steps through the recorded paid counts and adds today with the member count', () => {
    const now = Date.UTC(2026, 10, 12);
    expect(toSeatPoints(changes, seats, now)).toEqual([
      { at: Date.UTC(2026, 7, 1), paid: 5, used: null },
      { at: Date.UTC(2026, 9, 1), paid: 8, used: null },
      { at: now, paid: 8, used: 6 },
    ]);
  });

  it('summarizes today and the change since the first record', () => {
    expect(seatsTakeaway(changes, seats)).toBe(
      '6 of 8 paid seats used today. Paid seats went from 5 to 8 since 1 Aug 2026.'
    );
    expect(seatsTakeaway([changes[1]], seats)).toBe(
      '6 of 8 paid seats used today. Paid seats unchanged at 8 since 1 Oct 2026.'
    );
    expect(seatsTakeaway([], seats)).toBe('6 of 8 paid seats used today.');
  });
});
