import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { BillingEventModel, CreditTransaction, Organization, User, mongoose } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { AdminPaymentsQuerySchema, type AdminPaymentsFilter } from '@bike4mind/server-utils/app/utils/adminPayments';
import { adminPaymentsSummary, exportAdminPayments, listAdminPayments } from './adminPayments';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NOW = new Date('2026-11-10T12:00:00Z');
const RANGE = { from: '2026-11-01', to: '2026-11-10' };
const at = (iso: string) => new Date(iso);

const USER_A = new mongoose.Types.ObjectId().toString();
const USER_B = new mongoose.Types.ObjectId().toString();
const ORG = new mongoose.Types.ObjectId().toString();

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([CreditTransaction.syncIndexes(), BillingEventModel.syncIndexes()]);
});

afterEach(async () => {
  await Promise.all([
    CreditTransaction.deleteMany({}),
    BillingEventModel.deleteMany({}),
    User.deleteMany({}),
    Organization.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

let counter = 0;

// Raw inserts, so createdAt is the fixture's own (the store's start date is read from it).
const purchase = (fields: Record<string, unknown>) => {
  counter += 1;
  return {
    _id: new mongoose.Types.ObjectId(),
    type: 'purchase',
    ownerType: 'User',
    ownerId: USER_A,
    credits: 1000,
    amount: 1000,
    status: 'completed',
    stripePaymentIntentId: `pi_fixture_${counter}`,
    createdAt: at('2026-11-05T10:00:00Z'),
    updatedAt: at('2026-11-05T10:00:00Z'),
    ...fields,
  };
};

const event = (type: string, fields: Record<string, unknown>) => {
  counter += 1;
  const occurredAt = (fields.occurredAt as Date | undefined) ?? at('2026-11-05T10:00:00Z');
  return {
    _id: new mongoose.Types.ObjectId(),
    stripeEventId: `evt_fixture_${counter}`,
    type,
    ownerType: 'user',
    ownerId: USER_A,
    subscriptionId: null,
    amount: null,
    currency: 'usd',
    data: {},
    createdAt: occurredAt,
    updatedAt: occurredAt,
    ...fields,
    occurredAt,
  };
};

const invoicePaid = (fields: Record<string, unknown>) => event('invoice.payment_succeeded', fields);

const seed = async (purchases: Record<string, unknown>[], events: Record<string, unknown>[]) => {
  if (purchases.length > 0) await CreditTransaction.collection.insertMany(purchases);
  if (events.length > 0) await BillingEventModel.collection.insertMany(events);
};

/** The store's first row, a month before the range, so coverage is complete unless a test says otherwise. */
const storeStarted = () => event('customer.updated', { occurredAt: at('2026-10-01T00:00:00Z') });

const query = (fields: Partial<AdminPaymentsFilter> & { page?: number; limit?: number } = {}) =>
  AdminPaymentsQuerySchema.parse({ ...RANGE, ...fields });

describe('listAdminPayments', () => {
  it('merges credit purchases and subscription invoices, newest first, and skips what moved no money', async () => {
    await seed(
      [
        purchase({ createdAt: at('2026-11-03T09:00:00Z') }),
        purchase({ ownerType: 'Organization', ownerId: ORG, amount: 5000, createdAt: at('2026-11-07T09:00:00Z') }),
        // An admin top-up is a `subscription` ledger row: credits only, never a payment.
        purchase({
          type: 'subscription',
          amount: undefined,
          stripePaymentIntentId: 'admin_topup_x',
          createdAt: at('2026-11-06T09:00:00Z'),
        }),
        // Outside the range.
        purchase({ createdAt: at('2026-10-20T09:00:00Z') }),
      ],
      [
        storeStarted(),
        invoicePaid({
          amount: 1900,
          subscriptionId: 'sub_a',
          occurredAt: at('2026-11-08T09:00:00Z'),
          data: { invoiceId: 'in_a' },
        }),
        // A trial invoice.
        invoicePaid({ amount: 0, occurredAt: at('2026-11-04T09:00:00Z'), data: { invoiceId: 'in_trial' } }),
      ]
    );

    const result = await listAdminPayments(query(), NOW);

    expect(result.total).toBe(3);
    expect(result.payments.map(row => [row.kind, row.ownerType, row.amount, row.status])).toEqual([
      ['subscription', 'user', 1900, 'succeeded'],
      ['credit_purchase', 'organization', 5000, 'succeeded'],
      ['credit_purchase', 'user', 1000, 'succeeded'],
    ]);
    expect(result.payments[0]).toMatchObject({ invoiceId: 'in_a', subscriptionId: 'sub_a', credits: null });
  });

  it('collapses retried and redelivered invoice events to one row with the latest outcome', async () => {
    await seed(
      [],
      [
        storeStarted(),
        event('invoice.payment_failed', {
          amount: 1900,
          occurredAt: at('2026-11-02T09:00:00Z'),
          data: { invoiceId: 'in_retry' },
        }),
        invoicePaid({ amount: 1900, occurredAt: at('2026-11-03T09:00:00Z'), data: { invoiceId: 'in_retry' } }),
        // The same invoice under a second event id.
        invoicePaid({ amount: 1900, occurredAt: at('2026-11-03T09:00:01Z'), data: { invoiceId: 'in_retry' } }),
        event('invoice.payment_failed', {
          amount: 4900,
          occurredAt: at('2026-11-04T09:00:00Z'),
          data: { invoiceId: 'in_failed' },
        }),
      ]
    );

    const result = await listAdminPayments(query(), NOW);

    expect(result.payments.map(row => [row.invoiceId, row.status])).toEqual([
      ['in_failed', 'failed'],
      ['in_retry', 'succeeded'],
    ]);
  });

  it('derives refund and dispute status from Stripe events and legacy ledger flags', async () => {
    await seed(
      [
        purchase({ stripePaymentIntentId: 'pi_partial', createdAt: at('2026-11-02T09:00:00Z') }),
        purchase({ stripePaymentIntentId: 'pi_full', createdAt: at('2026-11-03T09:00:00Z') }),
        purchase({
          stripePaymentIntentId: 'pi_legacy',
          reversedAt: at('2026-11-04T00:00:00Z'),
          reversalReason: 'refunded',
          createdAt: at('2026-11-04T09:00:00Z'),
        }),
        purchase({ stripePaymentIntentId: 'pi_disputed', createdAt: at('2026-11-05T09:00:00Z') }),
        purchase({ stripePaymentIntentId: 'pi_pending', status: 'pending', createdAt: at('2026-11-06T09:00:00Z') }),
      ],
      [
        storeStarted(),
        // Cumulative amounts: 300, then 500 in total.
        event('charge.refunded', { amount: 300, data: { chargeId: 'ch_partial', paymentIntentId: 'pi_partial' } }),
        event('charge.refunded', { amount: 500, data: { chargeId: 'ch_partial', paymentIntentId: 'pi_partial' } }),
        event('charge.refunded', { amount: 1000, data: { chargeId: 'ch_full', paymentIntentId: 'pi_full' } }),
        event('charge.dispute.created', { amount: 1000, data: { disputeId: 'dp_1', paymentIntentId: 'pi_disputed' } }),
      ]
    );

    const byIntent = new Map((await listAdminPayments(query(), NOW)).payments.map(row => [row.paymentIntentId, row]));

    expect(byIntent.get('pi_partial')).toMatchObject({ status: 'partially_refunded', refundedAmount: 500 });
    expect(byIntent.get('pi_full')).toMatchObject({ status: 'refunded', refundedAmount: 1000 });
    expect(byIntent.get('pi_legacy')).toMatchObject({ status: 'refunded', refundedAmount: 1000 });
    expect(byIntent.get('pi_disputed')).toMatchObject({ status: 'disputed', refundedAmount: null });
    expect(byIntent.get('pi_pending')).toMatchObject({ status: 'pending' });

    const partial = await listAdminPayments(query({ status: 'partially_refunded' }), NOW);
    expect(partial.payments.map(row => row.paymentIntentId)).toEqual(['pi_partial']);
    expect(partial.total).toBe(1);
  });

  it('filters by owner type, amount and a search that resolves to owners, and hydrates owner names', async () => {
    await User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(USER_B),
      name: 'Rowan Vale',
      email: 'rowan@example.test',
    });
    await Organization.collection.insertOne({ _id: new mongoose.Types.ObjectId(ORG), name: 'Fixture Labs' });
    await seed(
      [
        purchase({ ownerId: USER_A, amount: 500 }),
        purchase({ ownerId: USER_B, amount: 2500 }),
        purchase({ ownerType: 'Organization', ownerId: ORG, amount: 9000 }),
      ],
      [storeStarted()]
    );

    const bySearch = await listAdminPayments(query({ search: 'rowan@' }), NOW);
    expect(bySearch.payments).toHaveLength(1);
    expect(bySearch.payments[0].owner).toEqual({
      kind: 'user',
      id: USER_B,
      name: 'Rowan Vale',
      email: 'rowan@example.test',
    });

    const orgs = await listAdminPayments(query({ ownerType: 'organization' }), NOW);
    expect(orgs.payments.map(row => row.owner)).toEqual([{ kind: 'organization', id: ORG, name: 'Fixture Labs' }]);

    const midRange = await listAdminPayments(query({ minAmount: 1000, maxAmount: 5000 }), NOW);
    expect(midRange.payments.map(row => row.amount)).toEqual([2500]);

    // A deleted owner stays a row, with no owner.
    const deleted = await listAdminPayments(query({ search: USER_A }), NOW);
    expect(deleted.payments).toHaveLength(1);
    expect(deleted.payments[0].owner).toBeNull();
  });

  it('pages with a stable total, and the export returns the same rows', async () => {
    await seed(
      Array.from({ length: 30 }, (_, index) =>
        purchase({ createdAt: new Date(at('2026-11-02T00:00:00Z').getTime() + index * 60_000) })
      ),
      [storeStarted()]
    );

    const first = await listAdminPayments(query({ limit: 25 }), NOW);
    const second = await listAdminPayments(query({ limit: 25, page: 2 }), NOW);
    expect([first.total, first.totalPages, first.payments.length, second.payments.length]).toEqual([30, 2, 25, 5]);

    const exported = await exportAdminPayments(query(), 100, NOW);
    expect(exported.rows.map(row => row.id)).toEqual([...first.payments, ...second.payments].map(row => row.id));
  });
});

describe('adminPaymentsSummary', () => {
  it('reports gross by kind, refunds by the day they happened, lost disputes and net', async () => {
    await seed(
      [
        purchase({ ownerId: USER_A, stripePaymentIntentId: 'pi_a', amount: 1000 }),
        purchase({ ownerId: USER_B, stripePaymentIntentId: 'pi_b', amount: 2000 }),
        purchase({ ownerId: USER_B, stripePaymentIntentId: 'pi_failed', amount: 2000, status: 'failed' }),
        // Paid before the range, refunded inside it, before the event store existed.
        purchase({
          ownerId: USER_B,
          stripePaymentIntentId: 'pi_legacy',
          amount: 700,
          reversedAt: at('2026-11-02T00:00:00Z'),
          reversalReason: 'refunded',
          createdAt: at('2026-09-01T00:00:00Z'),
        }),
      ],
      [
        storeStarted(),
        invoicePaid({ ownerType: 'organization', ownerId: ORG, amount: 4900, data: { invoiceId: 'in_org' } }),
        invoicePaid({ ownerId: USER_A, amount: 1900, data: { invoiceId: 'in_a' } }),
        // 200 refunded before the range, 500 in total by the end of it: 300 counts.
        event('charge.refunded', {
          amount: 200,
          occurredAt: at('2026-10-20T00:00:00Z'),
          data: { chargeId: 'ch_b', paymentIntentId: 'pi_b' },
        }),
        event('charge.refunded', {
          amount: 500,
          occurredAt: at('2026-11-06T00:00:00Z'),
          data: { chargeId: 'ch_b', paymentIntentId: 'pi_b' },
        }),
        // The same cumulative total re-sent adds nothing.
        event('charge.refunded', {
          amount: 500,
          occurredAt: at('2026-11-07T00:00:00Z'),
          data: { chargeId: 'ch_b', paymentIntentId: 'pi_b' },
        }),
        event('charge.dispute.closed', {
          ownerType: 'organization',
          ownerId: ORG,
          amount: 4900,
          occurredAt: at('2026-11-09T00:00:00Z'),
          data: { disputeId: 'dp_org', status: 'lost' },
        }),
        event('charge.dispute.closed', { amount: 999, data: { disputeId: 'dp_won', status: 'won' } }),
      ]
    );

    const { current, previous, bucket, series } = await adminPaymentsSummary(RANGE, NOW);

    expect(current.coverage.stripeEvents).toBe('complete');
    expect(current.totals).toEqual([
      {
        currency: 'usd',
        subscriptionGross: 6800,
        subscriptionCount: 2,
        creditGross: 3000,
        creditCount: 2,
        refunds: 300 + 700,
        disputeLosses: 4900,
        net: 6800 + 3000 - 1000 - 4900,
      },
    ]);
    // USER_A paid both ways, USER_B bought credits, the org paid a subscription: three payers.
    expect(current.payers).toEqual({ total: 3, subscriptionOnly: 1, creditOnly: 1, both: 1 });
    // USER_B bought before the range; USER_A never had.
    expect(current.creditBuyers).toEqual({ purchases: 2, buyers: 2, firstTime: 1, repeat: 1 });

    expect(previous).toMatchObject({ from: '2026-10-22', to: '2026-10-31' });
    expect(previous.totals[0]).toMatchObject({ creditGross: 0, refunds: 0 });

    expect(bucket).toBe('day');
    expect(series).toEqual([{ date: '2026-11-05', currency: 'usd', subscription: 6800, creditPurchase: 3000 }]);
  });

  it('keeps subscription totals unknown, not zero, before the event store existed', async () => {
    await seed(
      [purchase({ amount: 1000 })],
      [invoicePaid({ amount: 1900, occurredAt: at('2026-11-20T00:00:00Z'), data: { invoiceId: 'in_late' } })]
    );

    const { current } = await adminPaymentsSummary(RANGE, NOW);

    expect(current.coverage.stripeEvents).toBe('unavailable');
    expect(current.totals[0]).toMatchObject({
      subscriptionGross: null,
      subscriptionCount: null,
      creditGross: 1000,
      net: null,
    });

    const creditsOnly = await adminPaymentsSummary({ ...RANGE, kind: 'credit_purchase' }, NOW);
    expect(creditsOnly.current.totals[0]).toMatchObject({ subscriptionGross: 0, subscriptionCount: 0, net: 1000 });
  });

  it('reports partial coverage when the store started inside the range', async () => {
    await seed([], [event('customer.updated', { occurredAt: at('2026-11-06T00:00:00Z') })]);

    const { current, previous } = await adminPaymentsSummary(RANGE, NOW);

    expect(current.coverage).toEqual({ recordedFrom: '2026-11-06T00:00:00.000Z', stripeEvents: 'partial' });
    expect(previous.coverage.stripeEvents).toBe('unavailable');
  });

  it('keeps currencies apart', async () => {
    await seed(
      [purchase({ amount: 1000 })],
      [storeStarted(), invoicePaid({ amount: 2500, currency: 'eur', data: { invoiceId: 'in_eur' } })]
    );

    const { current } = await adminPaymentsSummary(RANGE, NOW);

    expect(current.totals.map(total => [total.currency, total.subscriptionGross, total.creditGross])).toEqual([
      ['eur', 2500, 0],
      ['usd', 0, 1000],
    ]);
    const eurOnly = await adminPaymentsSummary({ ...RANGE, currency: 'eur' }, NOW);
    expect(eurOnly.current.totals.map(total => total.currency)).toEqual(['eur']);
  });
});
