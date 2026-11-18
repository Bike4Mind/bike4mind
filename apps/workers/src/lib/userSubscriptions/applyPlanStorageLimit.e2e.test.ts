import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type Stripe from 'stripe';
import { Organization } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import {
  createMongoServer,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { applyPlanStorageLimit } from './applyPlanStorageLimit';

const metrics = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: metrics.emit }));
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoServer>>;
const logger = new Logger();
beforeAll(async () => {
  database = await createMongoServer();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  await Organization.collection.deleteMany({});
  metrics.emit.mockClear();
});

function subscription(metadata: Record<string, string>, status: Stripe.Subscription.Status): Stripe.Subscription {
  return {
    id: 'sub_local_fixture',
    status,
    items: { data: [{ price: { id: 'price_local_fixture', metadata }, quantity: 12 }] },
  } as unknown as Stripe.Subscription;
}

it.each(['active', 'trialing'] as const)(
  'persists one flat organization pool for a %s multi-seat subscription',
  async status => {
    const org = await Organization.create({ name: 'org', userId: 'owner', seats: 12, currentCredits: 123 });
    await applyPlanStorageLimit(subscription({ storageLimitMb: '50000' }, status), org.id, logger, 'Organization');
    expect(await Organization.findById(org.id).lean()).toMatchObject({
      storageLimit: 50_000,
      storageLimitOverride: null,
      planStorageLimit: 50_000,
      seats: 12,
      currentCredits: 123,
    });
    expect(metrics.emit).not.toHaveBeenCalled();
  }
);

it('retains an organization manual override while updating its subscribed flat plan', async () => {
  const org = await Organization.create({ name: 'org', userId: 'owner', storageLimit: 1234, seats: 12 });
  await applyPlanStorageLimit(subscription({ storageLimitMb: '50000' }, 'active'), org.id, logger, 'Organization');
  expect(await Organization.findById(org.id).lean()).toMatchObject({
    storageLimit: 1234,
    storageLimitOverride: 1234,
    planStorageLimit: 50_000,
    seats: 12,
  });
});

it.each<{ metadata: Record<string, string>; status: Stripe.Subscription.Status }>([
  { metadata: {}, status: 'active' },
  { metadata: { storageLimitMb: 'invalid' }, status: 'active' },
  { metadata: { storageLimitMb: '50000' }, status: 'canceled' },
])('keeps the stored pool for unusable or non-granting metadata $metadata / $status', async ({ metadata, status }) => {
  const org = await Organization.create({ name: 'org', userId: 'owner', storageLimit: 1234 });
  await applyPlanStorageLimit(subscription(metadata, status), org.id, logger, 'Organization');
  expect((await Organization.findById(org.id).lean())?.storageLimit).toBe(1234);
  expect((await Organization.findById(org.id).lean())?.planStorageLimit).toBeUndefined();
});

it('does not grant an organization pool through the User owner dispatch', async () => {
  const org = await Organization.create({ name: 'org', userId: 'owner', storageLimit: 1234 });
  await applyPlanStorageLimit(subscription({ storageLimitMb: '50000' }, 'active'), org.id, logger, 'User');
  expect((await Organization.findById(org.id).lean())?.storageLimit).toBe(1234);
  expect((await Organization.findById(org.id).lean())?.planStorageLimit).toBeUndefined();
});
