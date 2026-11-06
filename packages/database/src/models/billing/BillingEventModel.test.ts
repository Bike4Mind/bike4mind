import { beforeEach, describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { BillingEventModel, billingEventRepository, type BillingEventInput } from './BillingEventModel';

setupMongoTest();

beforeEach(async () => {
  // setupMongoTest drops the database between tests, unique index included; rebuild it so the upsert
  // runs against the real constraint.
  await BillingEventModel.syncIndexes();
});

const event = (overrides: Partial<BillingEventInput> = {}): BillingEventInput => ({
  stripeEventId: 'evt_1',
  type: 'invoice.payment_failed',
  ownerType: 'user',
  ownerId: 'user_1',
  subscriptionId: 'sub_1',
  amount: 1900,
  currency: 'usd',
  occurredAt: new Date('2026-10-01T00:00:00Z'),
  data: { invoiceId: 'in_1', attemptCount: 1 },
  ...overrides,
});

describe('BillingEventRepository', () => {
  it('keeps one row per Stripe event, and the first write wins on a redelivery', async () => {
    expect(await billingEventRepository.record(event())).toBe(true);
    expect(await billingEventRepository.record(event({ data: { invoiceId: 'in_1', attemptCount: 2 } }))).toBe(false);

    const rows = await BillingEventModel.find({ stripeEventId: 'evt_1' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({ invoiceId: 'in_1', attemptCount: 1 });
  });

  it('enforces stripeEventId uniqueness on a plain insert too', async () => {
    await BillingEventModel.create(event());
    await expect(BillingEventModel.create(event())).rejects.toMatchObject({ code: 11000 });
  });

  it('stores an event with no known owner or subscription', async () => {
    await billingEventRepository.record(
      event({ stripeEventId: 'evt_2', ownerType: null, ownerId: null, subscriptionId: null, amount: null })
    );
    const row = await BillingEventModel.findOne({ stripeEventId: 'evt_2' }).lean();
    expect(row).toMatchObject({ ownerType: null, ownerId: null, subscriptionId: null, amount: null });
  });

  it('lists one subscription newest first and pages on (occurredAt, id)', async () => {
    const at = (day: number) => new Date(Date.UTC(2026, 9, day));
    await billingEventRepository.record(event({ stripeEventId: 'evt_a', occurredAt: at(1) }));
    await billingEventRepository.record(event({ stripeEventId: 'evt_b', occurredAt: at(3) }));
    await billingEventRepository.record(event({ stripeEventId: 'evt_c', occurredAt: at(2) }));
    await billingEventRepository.record(
      event({ stripeEventId: 'evt_other', subscriptionId: 'sub_2', occurredAt: at(4) })
    );

    const first = await billingEventRepository.listForSubscription({ subscriptionId: 'sub_1' }, { limit: 2 });
    expect(first.records.map(record => record.stripeEventId)).toEqual(['evt_b', 'evt_c']);
    expect(first.hasMore).toBe(true);

    const last = first.records[1];
    const second = await billingEventRepository.listForSubscription(
      { subscriptionId: 'sub_1' },
      {
        limit: 2,
        cursor: { occurredAt: last.occurredAt, id: last.id },
      }
    );
    expect(second.records.map(record => record.stripeEventId)).toEqual(['evt_a']);
    expect(second.hasMore).toBe(false);
  });

  it('adds the owner events that name no subscription, only for the listed types', async () => {
    const owner = { ownerType: 'user' as const, ownerId: 'user_1' };
    await billingEventRepository.record(event({ stripeEventId: 'evt_sub' }));
    await billingEventRepository.record(
      event({ stripeEventId: 'evt_refund', type: 'charge.refunded', subscriptionId: null })
    );
    await billingEventRepository.record(
      event({ stripeEventId: 'evt_pack', type: 'payment_intent.succeeded', subscriptionId: null })
    );
    await billingEventRepository.record(
      event({ stripeEventId: 'evt_someone', type: 'charge.refunded', subscriptionId: null, ownerId: 'user_2' })
    );

    const page = await billingEventRepository.listForSubscription(
      { subscriptionId: 'sub_1', owner, ownerLevelTypes: ['charge.refunded'] },
      { limit: 10 }
    );
    expect(page.records.map(record => record.stripeEventId).sort()).toEqual(['evt_refund', 'evt_sub']);
  });
});
