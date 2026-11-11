import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  BillingEventModel,
  CreditLot,
  CreditTransaction,
  Organization,
  PendingCreditHoldModel,
  UsageEvent,
  User,
  mongoose,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { loadBillingOverview } from './loadBillingOverview';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NOW = new Date('2026-11-01T12:00:00Z');
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Promise.all(
    [
      Subscription,
      User,
      Organization,
      CreditTransaction,
      CreditLot,
      PendingCreditHoldModel,
      BillingEventModel,
      UsageEvent,
    ].map(model => (model as unknown as mongoose.Model<unknown>).deleteMany({}))
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

let seq = 0;
const next = () => ++seq;

/** Raw inserts so fixtures can set createdAt, as old ledger and usage rows have it. */
const ledger = (row: Record<string, unknown>) =>
  CreditTransaction.collection.insertOne({ updatedAt: row.createdAt, ...row });

const usage = (row: {
  userId: string;
  ownerId: string;
  ownerType: string;
  credits: number;
  at: Date;
  status?: string;
}) =>
  UsageEvent.collection.insertOne({
    requestId: `req_${next()}`,
    userId: row.userId,
    ownerId: row.ownerId,
    ownerType: row.ownerType,
    feature: 'chat',
    provider: 'test',
    model: 'test-model',
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
    creditsCharged: row.credits,
    status: row.status ?? 'ok',
    createdAt: row.at,
    updatedAt: row.at,
  });

const billingEvent = (row: Record<string, unknown>) =>
  BillingEventModel.collection.insertOne({
    stripeEventId: `evt_${next()}`,
    subscriptionId: null,
    amount: null,
    currency: 'usd',
    data: {},
    createdAt: daysAgo(400),
    updatedAt: daysAgo(400),
    ...row,
  });

const seed = async () => {
  const user = await User.create({ name: 'Ada', username: 'ada', email: 'ada@example.com', currentCredits: 1_500 });
  const other = await User.create({ name: 'Bob', username: 'bob', email: 'bob@example.com', currentCredits: 0 });
  const org = await Organization.create({ name: 'Acme', userId: user.id, currentCredits: 40_000 });
  const userId = String(user.id);
  const orgId = String(org.id);

  await Subscription.create({
    subscriptionId: 'sub_user',
    ownerType: 'User',
    ownerId: userId,
    priceId: 'price_test',
    status: 'active',
    source: 'stripe',
    quantity: 1,
    periodStartsAt: daysAgo(10),
    periodEndsAt: new Date(NOW.getTime() + 20 * DAY),
  });
  await Subscription.create({
    subscriptionId: 'admin_granted_org',
    ownerType: 'Organization',
    ownerId: orgId,
    priceId: 'price_test',
    status: 'active',
    source: 'admin_grant',
    quantity: 5,
    periodStartsAt: daysAgo(10),
    periodEndsAt: new Date(NOW.getTime() + 50 * DAY),
  });

  // A purchase inside the 90-day window, one before it, and a failed one that never counts.
  await ledger({
    ownerId: userId,
    ownerType: 'User',
    type: 'purchase',
    credits: 1_000,
    amount: 1_000,
    status: 'completed',
    stripePaymentIntentId: 'pi_recent',
    createdAt: daysAgo(5),
  });
  await ledger({
    ownerId: userId,
    ownerType: 'User',
    type: 'purchase',
    credits: 2_000,
    amount: 2_000,
    status: 'completed',
    stripePaymentIntentId: 'pi_old',
    createdAt: daysAgo(120),
  });
  await ledger({
    ownerId: userId,
    ownerType: 'User',
    type: 'purchase',
    credits: 500,
    amount: 500,
    status: 'failed',
    stripePaymentIntentId: 'pi_failed',
    createdAt: daysAgo(4),
  });
  await ledger({
    ownerId: userId,
    ownerType: 'User',
    type: 'subscription',
    credits: 5_000,
    stripePaymentIntentId: 'pi_invoice',
    createdAt: daysAgo(10),
  });
  // The organization's own grant must never show on the user.
  await ledger({
    ownerId: orgId,
    ownerType: 'Organization',
    type: 'generic_add',
    credits: 40_000,
    createdAt: daysAgo(3),
  });

  await CreditLot.create([
    { ownerId: userId, ownerType: 'User', source: 'subscription', amount: 5_000, expiresAt: daysAgo(-30) },
    { ownerId: userId, ownerType: 'User', source: 'pack', amount: 1_000, expiresAt: daysAgo(-300) },
  ]);

  await PendingCreditHoldModel.create([
    {
      ownerId: userId,
      ownerType: 'User',
      userId,
      reservedCredits: 40,
      balanceAfterHold: 1_500,
      featureLabel: 'chat',
      expiresAt: daysAgo(-1),
    },
    {
      ownerId: userId,
      ownerType: 'User',
      userId,
      reservedCredits: 999,
      balanceAfterHold: 1_500,
      featureLabel: 'chat',
      expiresAt: daysAgo(-1),
      settledAt: daysAgo(0),
      settledCredits: 999,
    },
    {
      ownerId: orgId,
      ownerType: 'Organization',
      userId,
      reservedCredits: 70,
      balanceAfterHold: 40_000,
      featureLabel: 'chat',
      expiresAt: daysAgo(-1),
    },
  ]);

  // Stripe sends both invoice events; the purchase's own intent event carries its currency.
  for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
    await billingEvent({
      type,
      ownerType: 'user',
      ownerId: userId,
      subscriptionId: 'sub_user',
      amount: 2_900,
      occurredAt: daysAgo(10),
      data: { invoiceId: 'in_1', paymentIntentId: 'pi_invoice', billingReason: 'subscription_cycle' },
    });
  }
  await billingEvent({
    type: 'payment_intent.succeeded',
    ownerType: 'user',
    ownerId: userId,
    amount: 1_000,
    occurredAt: daysAgo(5),
    data: { paymentIntentId: 'pi_recent' },
  });
  for (const amount of [200, 600]) {
    await billingEvent({
      type: 'charge.refunded',
      ownerType: 'user',
      ownerId: userId,
      amount,
      occurredAt: daysAgo(2),
      data: { chargeId: 'ch_recent', paymentIntentId: 'pi_recent' },
    });
  }

  // Personal usage, usage billed to the organization, and another member's organization usage.
  await usage({ userId, ownerId: userId, ownerType: 'User', credits: 300, at: daysAgo(1) });
  await usage({ userId, ownerId: userId, ownerType: 'User', credits: 50, at: daysAgo(0.5), status: 'error' });
  await usage({ userId, ownerId: orgId, ownerType: 'Organization', credits: 4_000, at: daysAgo(2) });
  await usage({ userId: String(other.id), ownerId: orgId, ownerType: 'Organization', credits: 1_000, at: daysAgo(2) });
  await usage({ userId, ownerId: userId, ownerType: 'User', credits: 9_999, at: daysAgo(200) });

  return { userId, orgId, otherId: String(other.id) };
};

describe('loadBillingOverview', () => {
  it('summarizes a user without their organization memberships and without double counting', async () => {
    const { userId, orgId } = await seed();
    const overview = await loadBillingOverview({ ownerType: 'user', ownerId: userId, range: '90d' }, logger, NOW);

    expect(overview.subscription).toMatchObject({ status: 'ok', standing: 'paid', current: { status: 'active' } });

    expect(overview.credits).toEqual({
      status: 'ok',
      available: 1_500,
      held: 40,
      heldRequests: 1,
      // 6,000 granted by lots, 1,500 left: the soonest-expiring subscription lot is consumed first.
      funding: { purchased: 1_000, subscription: 500, granted: 0, unknown: 0 },
    });

    if (overview.payments.status !== 'ok') throw new Error('payments unavailable');
    const kinds = overview.payments.records.map(record => record.kind).sort();
    expect(kinds).toEqual(['credit_purchase', 'refund', 'subscription_payment']);
    expect(overview.payments.totals).toEqual([
      {
        currency: 'usd',
        creditPurchases: { count: 1, amount: 1_000 },
        subscriptionPayments: { count: 1, amount: 2_900 },
        refunds: { count: 1, amount: 600 },
        disputes: { count: 0, amount: 0 },
      },
    ]);
    const [refund] = overview.payments.records.filter(record => record.kind === 'refund');
    expect(refund.label).toBe('Partial refund of a credit purchase');
    const local = await Subscription.findOne({ subscriptionId: 'sub_user' }).lean();
    expect(overview.payments.records.find(record => record.kind === 'subscription_payment')?.link).toEqual({
      kind: 'subscription',
      subscriptionId: String(local?._id),
      tab: 'invoices',
    });

    if (overview.usage.status !== 'ok') throw new Error('usage unavailable');
    const rows = Object.fromEntries(overview.usage.attribution.map(row => [row.billedTo, row]));
    expect(rows.user).toMatchObject({ billedToId: userId, credits: 350, events: 2 });
    expect(rows.organization).toMatchObject({
      billedToId: orgId,
      billedToName: 'Acme',
      credits: 4_000,
      events: 1,
      link: { kind: 'organization', organizationId: orgId },
    });
    expect(overview.usage.lastSuccessfulAt).toBe(daysAgo(1).toISOString());

    if (overview.activity.status !== 'ok') throw new Error('activity unavailable');
    const subscriptionCredits = overview.activity.items.find(item => item.summary === 'Subscription credits');
    const invoice = overview.activity.items.find(item => item.summary === 'Renewal');
    expect(subscriptionCredits?.verifiedLinkTo).toBe(invoice?.id);
    expect(
      overview.activity.items.filter(item => item.kind === 'consumption').every(item => !item.verifiedLinkTo)
    ).toBe(true);
  });

  it('summarizes an organization from its own subscription, balance and members', async () => {
    const { userId, orgId, otherId } = await seed();
    const overview = await loadBillingOverview(
      { ownerType: 'organization', ownerId: orgId, range: '90d' },
      logger,
      NOW
    );

    expect(overview.owner).toMatchObject({ type: 'organization', name: 'Acme' });
    expect(overview.subscription).toMatchObject({ status: 'ok', standing: 'comped', current: { quantity: 5 } });
    expect(overview.credits).toMatchObject({ status: 'ok', available: 40_000, held: 70, heldRequests: 1 });
    expect(overview.payments).toMatchObject({ status: 'ok', records: [], totals: [] });

    if (overview.usage.status !== 'ok') throw new Error('usage unavailable');
    const byMember = Object.fromEntries(overview.usage.attribution.map(row => [row.actorUserId, row.credits]));
    // The member's personal usage (350) is not the organization's.
    expect(byMember).toEqual({ [userId]: 4_000, [otherId]: 1_000 });
  });

  it('bounds every section by the window', async () => {
    const { userId } = await seed();
    const year = await loadBillingOverview({ ownerType: 'user', ownerId: userId, range: '365d' }, logger, NOW);
    if (year.payments.status !== 'ok' || year.usage.status !== 'ok') throw new Error('unavailable');
    // The older purchase has no Stripe event naming its currency, so it is never added to the USD row.
    expect(year.payments.totals.map(row => [row.currency, row.creditPurchases])).toEqual([
      ['usd', { count: 1, amount: 1_000 }],
      [null, { count: 1, amount: 2_000 }],
    ]);
    expect(year.usage.attribution.find(row => row.billedTo === 'user')?.credits).toBe(350 + 9_999);
  });

  it('flags an internal account and reports a missing owner as not found', async () => {
    const internal = await User.create({ name: 'Ops', username: 'ops', email: 'ops@example.com', isInternal: true });
    const overview = await loadBillingOverview(
      { ownerType: 'user', ownerId: String(internal.id), range: '30d' },
      logger,
      NOW
    );
    expect(overview.owner.internal).toBe(true);
    expect(overview.subscription).toMatchObject({ standing: 'none', current: null });
    expect(overview.credits).toMatchObject({ funding: { unknown: 0 } });

    await expect(
      loadBillingOverview(
        { ownerType: 'organization', ownerId: String(new mongoose.Types.ObjectId()), range: '30d' },
        logger,
        NOW
      )
    ).rejects.toThrow('Organization not found');
  });
});
