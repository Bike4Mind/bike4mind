import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnalyticsDaily, CreditTransaction, Organization, UsageEvent, User, mongoose } from '@bike4mind/database';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { loadSubscriptionUsage, matchesUsageCohort, subscriptionUsageDetail } from './subscriptionUsage';
import {
  adminSubscriptionsExportPage,
  adminSubscriptionsMatch,
  adminSubscriptionsSummary,
  listAdminSubscriptions,
  type SubscriptionDoc,
} from './listAdminSubscriptions';
import { subscriptionPlanCatalog } from './adminSubscriptionsQuery';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
vi.mock('@bike4mind/server-utils/analytics/signupCohort', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/analytics/signupCohort')>()),
  loadCountingContext: async () => ({ staffRegex: null, testDomains: [] }),
}));
const NOW = new Date('2026-06-15T12:00:00Z');
const DAY = 86_400_000;
let server: Awaited<ReturnType<typeof createMongoServer>>;
let sequence = 0;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterEach(async () => {
  await Promise.all(
    [Subscription, UsageEvent, User, Organization, CreditTransaction, AnalyticsDaily].map(model => model.deleteMany({}))
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
const user = (fields: Record<string, unknown> = {}) =>
  User.create({ name: 'Example', username: `person${++sequence}`, email: `person${sequence}@example.com`, ...fields });
const subscription = async (ownerId: string, fields: Record<string, unknown> = {}) => {
  const row = await Subscription.create({
    subscriptionId: `sub_${++sequence}`,
    priceId: 'price_example',
    ownerId,
    ownerType: 'User',
    source: 'stripe',
    status: 'active',
    quantity: 1,
    periodStartsAt: new Date(NOW.getTime() - 40 * DAY),
    periodEndsAt: NOW,
    createdAt: new Date(NOW.getTime() - 40 * DAY),
    ...fields,
  });
  return row.toObject() as SubscriptionDoc;
};
const event = async (ownerId: string, fields: Record<string, unknown> = {}) => {
  const doc = {
    requestId: `request${++sequence}`,
    userId: ownerId,
    ownerId,
    ownerType: 'User',
    feature: 'chat',
    provider: 'example',
    model: 'example',
    status: 'ok',
    source: 'web',
    costUsd: 0,
    creditsCharged: 5,
    createdAt: new Date(NOW.getTime() - DAY / 2),
    ...fields,
  };
  await UsageEvent.collection.insertOne(doc);
  return doc;
};
const coverage = async () => {
  await event('coverage-only', { createdAt: new Date(NOW.getTime() - 50 * DAY) });
  await event('coverage-only');
  await AnalyticsDaily.collection.insertMany(
    Array.from({ length: 28 }, (_, index) => ({
      day: new Date(NOW.getTime() - (index + 1) * DAY).toISOString().slice(0, 10),
      computedAt: NOW,
    }))
  );
};

describe('subscription usage observations', () => {
  it('attributes only org-billed calls, collapses exact replays, and leaves refunds out of consumption', async () => {
    const member = await user();
    const id = String(member._id);
    const org = await Organization.create({
      name: 'Example team',
      userId: id,
      users: [{ userId: id, permissions: ['read'] }],
    });
    const orgId = String(org._id);
    const personal = await subscription(id);
    const team = await subscription(orgId, { ownerType: 'Organization', quantity: 5 });
    await coverage();
    await event(id, { creditsCharged: 100 });
    const billed = await event(orgId, { userId: id, ownerType: 'Organization', creditsCharged: 8 });
    await UsageEvent.collection.insertOne({ ...billed, _id: new mongoose.Types.ObjectId() });
    await event(orgId, { userId: id, ownerType: 'Organization', source: 'api', creditsCharged: 3 });
    await event(orgId, { userId: id, ownerType: 'Organization', status: 'error', creditsCharged: 2 });
    await CreditTransaction.collection.insertOne({
      ownerId: orgId,
      ownerType: 'Organization',
      type: 'generic_add',
      credits: 8,
      createdAt: NOW,
    });
    const usages = await loadSubscriptionUsage([personal, team], NOW);
    expect(usages.get(String(team._id))).toMatchObject({
      firstPartyRequests: 1,
      apiRequests: 1,
      creditsConsumed: 13,
      recordedEvents: 3,
      coverage: 'observed',
    });
    expect(usages.get(String(personal._id))).toMatchObject({ firstPartyRequests: 1, creditsConsumed: 100 });
  });

  it('keeps count, table and export matches identical and excludes trials, comps, internal and new owners', async () => {
    await coverage();
    const owner = await user();
    const id = String(owner._id);
    const quiet = await subscription(id);
    await subscription(id, { status: 'trialing' });
    await subscription(id, { source: 'admin_grant' });
    await subscription(id, { createdAt: new Date(NOW.getTime() - DAY) });
    const internal = await user({ isAdmin: true });
    await subscription(String(internal._id));
    const active = await user();
    const canceling = await subscription(String(active._id), { canceledAt: new Date(NOW.getTime() - DAY) });
    await subscription(String(active._id), { status: 'canceled', canceledAt: NOW });
    await event(String(active._id));
    for (const [usageCohort, expected] of [
      ['payingNoRecorded', quiet],
      ['cancelingRecent', canceling],
    ] as const) {
      const filter = { usageCohort };
      const list = await listAdminSubscriptions(
        { ...filter, page: 1, limit: 25, sortField: 'createdAt', sortOrder: 'desc' },
        NOW
      );
      const summary = await adminSubscriptionsSummary(filter, NOW);
      const { match } = await adminSubscriptionsMatch(filter, NOW, subscriptionPlanCatalog());
      const exported = await adminSubscriptionsExportPage(match, null, 100, subscriptionPlanCatalog());
      expect(list.subscriptions.map(row => row.id)).toEqual([String(expected._id)]);
      expect(summary.total).toBe(list.total);
      expect(exported.map(row => row.id)).toEqual(list.subscriptions.map(row => row.id));
    }
  });

  it('does not turn absent, incomplete or unclassified history into confirmed inactivity', async () => {
    const owner = await user();
    const row = await subscription(String(owner._id));
    let usage = (await loadSubscriptionUsage([row], NOW)).get(String(row._id))!;
    expect(usage).toMatchObject({
      coverage: 'unknown',
      firstPartyRequests: null,
      apiRequests: null,
      creditsConsumed: null,
    });
    expect(matchesUsageCohort(row, usage, 'payingNoRecorded')).toBe(false);
    await event(String(owner._id), { source: undefined });
    usage = (await loadSubscriptionUsage([row], NOW)).get(String(row._id))!;
    expect(usage).toMatchObject({ coverage: 'incomplete', firstPartyRequests: null, apiRequests: null });
    expect(matchesUsageCohort(row, usage, 'payingNoRecorded')).toBe(false);
  });

  it('requires every historical daily marker even when the store spans the window', async () => {
    await coverage();
    const owner = await user();
    const row = await subscription(String(owner._id));
    await AnalyticsDaily.deleteOne({ day: '2026-06-01' });
    const usage = (await loadSubscriptionUsage([row], NOW)).get(String(row._id))!;
    expect(usage).toMatchObject({ coverage: 'incomplete', firstPartyRequests: null });
    expect(matchesUsageCohort(row, usage, 'payingNoRecorded')).toBe(false);
    expect(await subscriptionUsageDetail(String(row._id).toUpperCase())).toBeDefined();
  });
});
