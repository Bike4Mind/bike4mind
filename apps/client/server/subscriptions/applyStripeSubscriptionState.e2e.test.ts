import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  AdminAuditLogModel,
  BillingMismatchModel,
  Organization,
  billingMismatchRepository,
  withTransaction,
} from '@bike4mind/database';
import { Subscription, subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { applyStripeSubscriptionState } from './applyStripeSubscriptionState';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let replicaSet: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  replicaSet = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(replicaSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([
    Subscription.createCollection(),
    Organization.createCollection(),
    BillingMismatchModel.createCollection(),
    AdminAuditLogModel.createCollection(),
  ]);
});
afterEach(async () => {
  await Promise.all([
    Subscription.deleteMany({}),
    Organization.deleteMany({}),
    BillingMismatchModel.deleteMany({}),
    AdminAuditLogModel.collection.deleteMany({}),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
});

const stripeSubscription = {
  id: 'sub_transaction',
  status: 'active' as const,
  canceled_at: null,
  customer: 'cus_transaction',
  currency: 'usd',
  cancel_at_period_end: false,
  cancel_at: null,
  trial_end: null,
  items: {
    data: [
      {
        quantity: 3,
        current_period_start: 1_800_000_000,
        current_period_end: 1_802_592_000,
        price: {
          id: 'price_team',
          unit_amount: 2000,
          currency: 'usd',
          recurring: { interval: 'month' as const, interval_count: 1 },
        },
      },
    ],
  },
};

const seed = async () => {
  const organization = await Organization.create({
    name: 'Transactional team',
    userId: 'owner',
    stripeCustomerId: stripeSubscription.customer,
    seats: 5,
  });
  const row = await Subscription.create({
    ownerType: SubscriptionOwnerType.Organization,
    ownerId: organization.id,
    subscriptionId: stripeSubscription.id,
    source: 'stripe',
    status: 'active',
    priceId: 'price_team',
    quantity: 1,
    periodStartsAt: new Date(1_800_000_000_000),
    periodEndsAt: new Date(1_802_592_000_000),
  });
  await billingMismatchRepository.upsertOpen(
    {
      stripeSubscriptionId: stripeSubscription.id,
      subscriptionRowId: row.id,
      kind: 'drift',
      ownerType: 'Organization',
      ownerId: organization.id,
      fields: [{ field: 'seats', mongo: '5', stripe: '3' }],
      stripeStatus: 'active',
    },
    new Date()
  );
  return { organization, row };
};

const audit = (organizationId: string, summary: string) =>
  AdminAuditLogModel.create({
    occurredAt: new Date(),
    action: 'billing.subscription.synced',
    category: 'support',
    severity: 'info',
    actor: { kind: 'user', scope: 'platform', userId: 'admin', name: 'Admin', wasAdmin: true },
    target: { kind: 'organization', id: organizationId, displayName: 'Transactional team' },
    summary,
    context: { source: 'admin_ui' },
  });

describe('Stripe state write on a real replica set', () => {
  it('commits organization seats, the subscription row, audit and finding resolution in one transaction', async () => {
    const { organization, row } = await seed();
    const current = await subscriptionRepository.findById(row.id);
    await withTransaction(async () => {
      const applied = await applyStripeSubscriptionState(stripeSubscription, {
        ownerType: SubscriptionOwnerType.Organization,
        expectedUpdatedAt: current!.updatedAt,
      });
      expect(applied.before?.quantity).toBe(1);
      await audit(organization.id, 'Synced subscription');
      await billingMismatchRepository.resolveForSubscription(row.id, 'sync');
    });
    expect((await Subscription.findById(row.id).lean())?.quantity).toBe(3);
    expect((await Organization.findById(organization.id).lean())?.seats).toBe(3);
    expect(await AdminAuditLogModel.countDocuments({})).toBe(1);
    expect((await BillingMismatchModel.findOne({}).lean())?.status).toBe('resolved');
  });

  it('rolls back the subscription and seat writes when the strict audit write fails', async () => {
    const { organization, row } = await seed();
    await expect(
      withTransaction(async () => {
        await applyStripeSubscriptionState(stripeSubscription, { ownerType: SubscriptionOwnerType.Organization });
        await audit(organization.id, '');
        await billingMismatchRepository.resolveForSubscription(row.id, 'sync');
      })
    ).rejects.toThrow();
    expect((await Subscription.findById(row.id).lean())?.quantity).toBe(1);
    expect((await Organization.findById(organization.id).lean())?.seats).toBe(5);
    expect(await AdminAuditLogModel.countDocuments({})).toBe(0);
    expect((await BillingMismatchModel.findOne({}).lean())?.status).toBe('open');
  });
});
