import { describe, expect, it } from 'vitest';
import type { AdminSubscriptionRow } from '@bike4mind/server-utils/app/utils/adminSubscriptionsFilter';
import {
  buildActivity,
  fundingOfBalance,
  subscriptionStanding,
  summarizePayments,
  totalsByCurrency,
  type BillingEventRow,
  type DailyConsumptionRow,
  type PaymentContext,
  type PurchaseRow,
} from './billingOverviewModel';

const USER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const context: PaymentContext = {
  ownerType: 'user',
  ownerId: USER,
  localSubscriptionIds: new Map([['sub_1', 'local-sub-1']]),
};

const purchase = (overrides: Partial<PurchaseRow> = {}): PurchaseRow => ({
  id: 'tx1',
  createdAt: new Date('2026-10-01T10:00:00Z'),
  credits: 10_000,
  amount: 1_000,
  status: 'completed',
  stripePaymentIntentId: 'pi_pack',
  reversedAt: null,
  reversalReason: null,
  ...overrides,
});

let eventSeq = 0;
const event = (type: string, overrides: Partial<BillingEventRow> = {}): BillingEventRow => {
  eventSeq += 1;
  return {
    id: `ev${eventSeq}`,
    stripeEventId: `evt_${eventSeq}`,
    type,
    occurredAt: new Date('2026-10-02T10:00:00Z'),
    amount: null,
    currency: 'usd',
    subscriptionId: null,
    data: {},
    ...overrides,
  };
};

const invoicePaid = (overrides: Partial<BillingEventRow> = {}) =>
  event('invoice.payment_succeeded', {
    amount: 2_000,
    subscriptionId: 'sub_1',
    data: { invoiceId: 'in_1', paymentIntentId: 'pi_inv', billingReason: 'subscription_cycle' },
    ...overrides,
  });

describe('summarizePayments', () => {
  it('counts an invoice once when both invoice.paid and invoice.payment_succeeded (or a redelivery) arrive', () => {
    const records = summarizePayments(
      [],
      [invoicePaid(), invoicePaid({ type: 'invoice.paid' }), invoicePaid({ stripeEventId: 'evt_retry' })],
      context
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'subscription_payment',
      amount: 2_000,
      label: 'Renewal',
      link: { kind: 'subscription', subscriptionId: 'local-sub-1', tab: 'invoices' },
    });
  });

  it('keeps the original payment time when a duplicate invoice event arrives later', () => {
    const records = summarizePayments(
      [],
      // Newest first, as the loader reads them.
      [
        invoicePaid({ type: 'invoice.paid', occurredAt: new Date('2026-10-02T11:00:00Z') }),
        invoicePaid({ occurredAt: new Date('2026-10-02T10:00:00Z') }),
      ],
      context
    );
    expect(records[0].at).toBe('2026-10-02T10:00:00.000Z');
  });

  it('keeps an invoice whose amount arrived only on a later duplicate', () => {
    const records = summarizePayments([], [invoicePaid({ amount: null }), invoicePaid({ amount: 2_000 })], context);
    expect(records[0].amount).toBe(2_000);
  });

  it('counts each completed purchase once and leaves pending or failed ones out', () => {
    const records = summarizePayments(
      [
        purchase(),
        purchase({ id: 'tx-dup' }),
        purchase({ id: 'tx2', status: 'pending', stripePaymentIntentId: 'pi_2' }),
      ],
      [event('payment_intent.succeeded', { data: { paymentIntentId: 'pi_pack' }, currency: 'eur' })],
      context
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'credit_purchase',
      amount: 1_000,
      currency: 'eur',
      credits: 10_000,
      link: { kind: 'userCredits', userId: USER },
    });
  });

  it('never assumes a currency for a purchase Stripe recorded no event for', () => {
    const [record] = summarizePayments([purchase()], [], context);
    expect(record.currency).toBeNull();
  });

  it('resolves partial refunds to the charge cumulative amount instead of summing the events', () => {
    const refund = (amount: number, at: string) =>
      event('charge.refunded', {
        amount,
        occurredAt: new Date(at),
        data: { chargeId: 'ch_1', paymentIntentId: 'pi_pack' },
      });
    const records = summarizePayments(
      [purchase()],
      // Stripe's amount_refunded is cumulative: 300 then 700 means 700 refunded, not 1,000.
      [refund(300, '2026-10-03T00:00:00Z'), refund(700, '2026-10-04T00:00:00Z'), refund(300, '2026-10-03T00:00:00Z')],
      context
    );
    const refunds = records.filter(record => record.kind === 'refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amount: 700, label: 'Partial refund of a credit purchase' });
    expect(totalsByCurrency(records).find(row => row.currency === 'usd')?.refunds).toEqual({ count: 1, amount: 700 });
  });

  it('labels a refund of the whole charge as full', () => {
    const records = summarizePayments(
      [],
      [
        invoicePaid(),
        event('charge.refunded', { amount: 2_000, data: { chargeId: 'ch_2', paymentIntentId: 'pi_inv' } }),
      ],
      context
    );
    expect(records.find(record => record.kind === 'refund')).toMatchObject({
      label: 'Full refund of a subscription payment',
      link: { kind: 'subscription', subscriptionId: 'local-sub-1', tab: 'invoices' },
    });
  });

  it('counts a dispute once, with the status of its latest event', () => {
    const records = summarizePayments(
      [],
      [
        event('charge.dispute.created', {
          amount: 1_000,
          occurredAt: new Date('2026-10-05T00:00:00Z'),
          data: { disputeId: 'dp_1', status: 'needs_response', reason: 'fraudulent' },
        }),
        event('charge.dispute.closed', {
          amount: 1_000,
          occurredAt: new Date('2026-10-20T00:00:00Z'),
          data: { disputeId: 'dp_1', status: 'lost', reason: 'fraudulent' },
        }),
      ],
      context
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'dispute',
      at: '2026-10-05T00:00:00.000Z',
      status: 'lost',
      link: { kind: 'disputes' },
    });
  });

  it('gives an organization purchase no user ledger link', () => {
    const [record] = summarizePayments([purchase()], [], { ...context, ownerType: 'organization' });
    expect(record.link).toBeNull();
  });
});

describe('totalsByCurrency', () => {
  it('keeps each currency, and the unknown currency, on its own row', () => {
    const records = summarizePayments(
      [purchase()],
      [invoicePaid(), invoicePaid({ currency: 'eur', amount: 900, data: { invoiceId: 'in_eur' } })],
      context
    );
    const totals = totalsByCurrency(records);
    expect(totals.map(row => row.currency)).toEqual(['eur', 'usd', null]);
    expect(totals[0].subscriptionPayments).toEqual({ count: 1, amount: 900 });
    expect(totals[1].subscriptionPayments).toEqual({ count: 1, amount: 2_000 });
    expect(totals[2].creditPurchases).toEqual({ count: 1, amount: 1_000 });
  });

  it('counts a record with no amount without adding it', () => {
    const totals = totalsByCurrency(summarizePayments([], [invoicePaid({ amount: null })], context));
    expect(totals[0].subscriptionPayments).toEqual({ count: 1, amount: 0 });
  });
});

describe('fundingOfBalance', () => {
  const lot = (source: 'pack' | 'subscription' | 'promo' | 'legacy', amount: number, extra = {}) => ({
    source,
    amount,
    ...extra,
  });

  it('splits the balance by the lots still holding credits, soonest-expiring consumed first', () => {
    // 300 granted (consumed first), 500 subscription, 1,000 purchased; 1,200 left means 600 consumed.
    expect(fundingOfBalance([lot('promo', 300), lot('subscription', 500), lot('pack', 1_000)], 1_200)).toEqual({
      granted: 0,
      subscription: 200,
      purchased: 1_000,
      unknown: 0,
    });
  });

  it('reports balance the lots do not cover as unknown rather than zero', () => {
    expect(fundingOfBalance([], 750)).toEqual({ granted: 0, subscription: 0, purchased: 0, unknown: 750 });
  });

  it('honors a comped subscription lot and skips settled lots', () => {
    expect(
      fundingOfBalance(
        [lot('pack', 100, { settledAt: new Date() }), lot('subscription', 400, { fundingSource: 'granted' })],
        400
      )
    ).toEqual({ granted: 400, subscription: 0, purchased: 0, unknown: 0 });
  });

  it('shows nothing funded for a balance in debt', () => {
    expect(fundingOfBalance([lot('pack', 100)], -50)).toEqual({
      granted: 0,
      subscription: 0,
      purchased: 0,
      unknown: 0,
    });
  });
});

const row = (overrides: Partial<AdminSubscriptionRow>): AdminSubscriptionRow =>
  ({
    id: 'r1',
    subscriptionId: 'sub_1',
    ownerType: 'User',
    ownerId: USER,
    owner: null,
    ownerAlert: null,
    plan: { priceId: 'price_1', name: 'Pro', interval: 'monthly' },
    billedInterval: null,
    status: 'active',
    source: 'stripe',
    quantity: 1,
    customCreditsPerCycle: null,
    mrr: null,
    periodStartsAt: null,
    periodEndsAt: '2026-12-01T00:00:00.000Z',
    canceledAt: null,
    cancelAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as AdminSubscriptionRow;

describe('subscriptionStanding', () => {
  it('has no standing without subscriptions', () => {
    expect(subscriptionStanding([])).toEqual({ standing: 'none', current: null, previous: [] });
  });

  it('reads paid, trial, past due and comped from the live row', () => {
    expect(subscriptionStanding([row({})]).standing).toBe('paid');
    expect(subscriptionStanding([row({ status: 'trialing' })]).standing).toBe('trial');
    expect(subscriptionStanding([row({ status: 'past_due' })]).standing).toBe('past_due');
    expect(subscriptionStanding([row({ source: 'admin_grant' })]).standing).toBe('comped');
  });

  it('prefers an active row over an older canceled one, and lists the rest as previous', () => {
    const result = subscriptionStanding([
      row({ id: 'old', status: 'canceled', canceledAt: '2026-02-01T00:00:00.000Z' }),
      row({ id: 'live' }),
    ]);
    expect(result.current?.id).toBe('live');
    expect(result.previous.map(each => each.id)).toEqual(['old']);
  });

  it('reads ended when every row is terminal', () => {
    expect(subscriptionStanding([row({ status: 'canceled' })])).toMatchObject({ standing: 'ended', current: null });
  });
});

const consumptionRow = (overrides: Partial<DailyConsumptionRow> & { day: string }): DailyConsumptionRow => ({
  lastAt: new Date(`${overrides.day}T12:00:00Z`),
  credits: 0,
  events: 0,
  billedToKey: `User:${USER}`,
  billedToLabel: null,
  ...overrides,
});

describe('buildActivity', () => {
  it('keeps two payers with the same label on separate, distinct rows', () => {
    const { items } = buildActivity(
      [],
      [],
      [
        consumptionRow({
          day: '2026-10-02',
          credits: 10,
          events: 1,
          billedToKey: 'Agent:a1',
          billedToLabel: 'an agent',
        }),
        consumptionRow({
          day: '2026-10-02',
          credits: 20,
          events: 1,
          billedToKey: 'Agent:a2',
          billedToLabel: 'an agent',
        }),
      ]
    );
    expect(new Set(items.map(item => item.id)).size).toBe(2);
  });

  it('dates a day of usage at its last request, never after something later that day', () => {
    const { items } = buildActivity(
      summarizePayments([purchase({ createdAt: new Date('2026-10-02T15:00:00Z') })], [], context),
      [],
      [consumptionRow({ day: '2026-10-02', lastAt: new Date('2026-10-02T09:00:00Z'), credits: 5, events: 1 })]
    );
    expect(items.map(item => item.kind)).toEqual(['payment', 'consumption']);
  });

  it('marks credits from a purchase that was later reversed', () => {
    const { items } = buildActivity(
      [],
      [
        {
          id: 'tx',
          createdAt: new Date('2026-10-01T00:00:00Z'),
          type: 'purchase',
          credits: 100,
          stripePaymentIntentId: 'pi_x',
          reason: null,
          reversed: true,
        },
      ],
      []
    );
    expect(items[0].summary).toBe('Credits from a purchase (purchase later reversed)');
  });

  it('links credits to a payment only through the same payment intent, and never links usage', () => {
    const payments = summarizePayments([purchase()], [invoicePaid()], context);
    const { items } = buildActivity(
      payments,
      [
        {
          id: 'tx1',
          createdAt: new Date('2026-10-01T10:00:00Z'),
          type: 'purchase',
          credits: 10_000,
          stripePaymentIntentId: 'pi_pack',
          reason: null,
          reversed: false,
        },
        {
          id: 'grant',
          createdAt: new Date('2026-10-02T10:00:01Z'),
          type: 'generic_add',
          credits: 500,
          stripePaymentIntentId: null,
          reason: 'admin_adjustment',
          reversed: false,
        },
        {
          id: 'subcredits',
          createdAt: new Date('2026-10-02T10:00:02Z'),
          type: 'subscription',
          credits: 5_000,
          stripePaymentIntentId: 'pi_other',
          reason: null,
          reversed: false,
        },
      ],
      [consumptionRow({ day: '2026-10-02', credits: 120, events: 3 })]
    );
    const byId = new Map(items.map(item => [item.id, item]));
    expect(byId.get('activity:credit:tx1')?.verifiedLinkTo).toBe('activity:purchase:tx1');
    // Close in time to the invoice, but nothing records that this grant came from it.
    expect(byId.get('activity:credit:grant')?.verifiedLinkTo).toBeNull();
    expect(byId.get('activity:credit:subcredits')?.verifiedLinkTo).toBeNull();
    const usage = items.find(item => item.kind === 'consumption');
    expect(usage).toMatchObject({ credits: -120, verifiedLinkTo: null });
  });

  it('keeps consumption billed to different payers on separate rows', () => {
    const { items } = buildActivity(
      [],
      [],
      [
        consumptionRow({ day: '2026-10-02', credits: 100, events: 2 }),
        consumptionRow({
          day: '2026-10-02',
          credits: 900,
          events: 5,
          billedToKey: 'Organization:o1',
          billedToLabel: 'Acme',
        }),
      ]
    );
    expect(items).toHaveLength(2);
    expect(items.map(item => item.summary).sort()).toEqual(['2 requests', '5 requests, billed to Acme']);
  });

  it('caps the list and says so', () => {
    const consumption = Array.from({ length: 120 }, (_, index) =>
      consumptionRow({ day: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10), credits: 1, events: 1 })
    );
    const result = buildActivity([], [], consumption);
    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.items[0].at > result.items[99].at).toBe(true);
  });
});
