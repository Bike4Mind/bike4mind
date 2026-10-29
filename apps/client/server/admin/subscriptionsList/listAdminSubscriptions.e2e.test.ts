import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Organization, User, mongoose } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { Subscription } from '@server/models/Subscription';
import {
  adminSubscriptionsExportPage,
  adminSubscriptionsMatch,
  adminSubscriptionsSummary,
  listAdminSubscriptions,
  OWNER_SEARCH_LIMIT,
} from './listAdminSubscriptions';
import { subscriptionPlanCatalog } from './adminSubscriptionsQuery';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NOW = new Date('2026-06-15T12:00:00Z');
const DAY = 86_400_000;
const params = { page: 1, limit: 25, sortField: 'createdAt', sortOrder: 'desc' } as const;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  // Per-collection delete, NOT dropDatabase: dropping would also drop the unique subscriptionId index.
  await Promise.all([Subscription.deleteMany({}), User.deleteMany({}), Organization.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

let counter = 0;
const nextId = () => `${++counter}`.padStart(6, '0');

const seedUser = (name: string, fields: Record<string, unknown> = {}) =>
  User.create({ name, username: name, email: `${name}@example.com`, ...fields });

const seedOrganization = (name: string, billingOwnerId: string, fields: Record<string, unknown> = {}) =>
  Organization.create({ name, userId: billingOwnerId, ...fields });

type SubscriptionOverrides = Partial<{
  subscriptionId: string;
  ownerType: 'User' | 'Organization';
  ownerId: string;
  priceId: string;
  status: string;
  source: string;
  canceledAt: Date | null;
  periodEndsAt: Date;
  createdAt: Date;
  quantity: number;
  unitAmount: number | null;
  currency: string;
  interval: string;
  intervalCount: number;
}>;

const seedSubscription = (ownerId: string, overrides: SubscriptionOverrides = {}) =>
  Subscription.create({
    subscriptionId: `sub_${nextId()}`,
    ownerType: 'User',
    ownerId,
    priceId: 'price_test',
    status: 'active',
    source: 'stripe',
    quantity: 1,
    periodStartsAt: new Date(NOW.getTime() - 10 * DAY),
    periodEndsAt: new Date(NOW.getTime() + 20 * DAY),
    createdAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  });

const catalog = subscriptionPlanCatalog();

describe('listAdminSubscriptions', () => {
  it('lists user and organization rows with the owner hydrated', async () => {
    const user = await seedUser('jane', { stripeCustomerId: 'cus_jane' });
    const billingOwner = await seedUser('boss');
    const organization = await seedOrganization('Acme', String(billingOwner._id), {
      seats: 5,
      stripeCustomerId: 'cus_acme',
      users: [{ userId: 'm1', permissions: ['read'] }],
    });
    await seedSubscription(String(user._id), { createdAt: new Date(NOW.getTime() - 2 * DAY) });
    await seedSubscription(String(organization._id), { ownerType: 'Organization' });

    const result = await listAdminSubscriptions(params, NOW);

    expect(result.total).toBe(2);
    expect(result.searchTruncated).toBe(false);
    const [orgRow, userRow] = result.subscriptions;
    expect(orgRow.owner).toEqual({
      kind: 'Organization',
      id: String(organization._id),
      name: 'Acme',
      stripeCustomerId: 'cus_acme',
      seats: 5,
      memberCount: 2,
      billingOwnerId: String(billingOwner._id),
    });
    expect(userRow.owner).toEqual({
      kind: 'User',
      id: String(user._id),
      name: 'jane',
      username: 'jane',
      email: 'jane@example.com',
      stripeCustomerId: 'cus_jane',
    });
    expect(userRow.plan).toEqual({ priceId: 'price_test', name: null, interval: null });
  });

  it('pages 30 rows at 25 per page', async () => {
    const user = await seedUser('jane');
    for (let i = 0; i < 30; i++) {
      await seedSubscription(String(user._id), { createdAt: new Date(NOW.getTime() - i * 1000) });
    }

    const page1 = await listAdminSubscriptions(params, NOW);
    const page2 = await listAdminSubscriptions({ ...params, page: 2 }, NOW);

    expect(page1.subscriptions).toHaveLength(25);
    expect(page2.subscriptions).toHaveLength(5);
    expect(page2).toMatchObject({ total: 30, totalPages: 2, page: 2 });
    expect(new Set([...page1.subscriptions, ...page2.subscriptions].map(row => row.id)).size).toBe(30);
  });

  it('filters by status and owner type', async () => {
    const user = await seedUser('jane');
    const organization = await seedOrganization('Acme', String(user._id));
    await seedSubscription(String(user._id), { status: 'active' });
    await seedSubscription(String(user._id), { status: 'past_due' });
    await seedSubscription(String(organization._id), { ownerType: 'Organization', status: 'past_due' });

    const pastDue = await listAdminSubscriptions({ ...params, status: ['past_due'] }, NOW);
    const orgs = await listAdminSubscriptions({ ...params, ownerType: 'Organization' }, NOW);

    expect(pastDue.total).toBe(2);
    expect(orgs.subscriptions.map(row => row.ownerType)).toEqual(['Organization']);
  });

  describe('search', () => {
    it('finds a user by part of their email, and the org they are the billing owner of', async () => {
      const user = await seedUser('jane');
      const other = await seedUser('bob');
      const organization = await seedOrganization('Unrelated Inc', String(user._id));
      const otherOrganization = await seedOrganization('Other Inc', String(other._id));
      const userSub = await seedSubscription(String(user._id));
      const orgSub = await seedSubscription(String(organization._id), { ownerType: 'Organization' });
      await seedSubscription(String(other._id));
      await seedSubscription(String(otherOrganization._id), { ownerType: 'Organization' });

      const result = await listAdminSubscriptions({ ...params, search: 'jane@exam' }, NOW);

      expect(result.subscriptions.map(row => row.id).sort()).toEqual([String(userSub._id), String(orgSub._id)].sort());
    });

    it('matches a Stripe customer id exactly on users and organizations', async () => {
      const user = await seedUser('jane', { stripeCustomerId: 'cus_x' });
      const other = await seedUser('bob', { stripeCustomerId: 'cus_xy' });
      const organization = await seedOrganization('Acme', String(other._id), { stripeCustomerId: 'cus_x' });
      await seedSubscription(String(user._id));
      await seedSubscription(String(other._id));
      await seedSubscription(String(organization._id), { ownerType: 'Organization' });

      const result = await listAdminSubscriptions({ ...params, search: 'cus_x' }, NOW);

      expect(result.total).toBe(2);
      expect(result.subscriptions.map(row => row.owner?.id).sort()).toEqual(
        [String(user._id), String(organization._id)].sort()
      );
    });

    it('matches a subscription id', async () => {
      const user = await seedUser('jane');
      await seedSubscription(String(user._id), { subscriptionId: 'sub_wanted' });
      await seedSubscription(String(user._id), { subscriptionId: 'sub_other' });

      const result = await listAdminSubscriptions({ ...params, search: 'sub_wanted' }, NOW);

      expect(result.subscriptions.map(row => row.subscriptionId)).toEqual(['sub_wanted']);
    });

    it('matches the subscription _id', async () => {
      const user = await seedUser('jane');
      const wanted = await seedSubscription(String(user._id));
      await seedSubscription(String(user._id));

      // The owner id is also a 24-hex string, so it widens to every row of that owner.
      const byRowId = await listAdminSubscriptions({ ...params, search: String(wanted._id) }, NOW);
      const byOwnerId = await listAdminSubscriptions({ ...params, search: String(user._id) }, NOW);

      expect(byRowId.subscriptions.map(row => row.id)).toEqual([String(wanted._id)]);
      expect(byOwnerId.total).toBe(2);
    });

    it('keeps an owner id search on the owner index instead of walking the sort index', async () => {
      const user = await seedUser('jane');
      await seedSubscription(String(user._id));
      await Subscription.insertMany(
        Array.from({ length: 300 }, () => ({
          subscriptionId: `sub_${nextId()}`,
          ownerType: 'User',
          ownerId: new mongoose.Types.ObjectId().toHexString(),
          priceId: 'price_test',
          status: 'active',
          source: 'stripe',
          quantity: 1,
          periodStartsAt: NOW,
          periodEndsAt: NOW,
        }))
      );
      await Subscription.syncIndexes();

      const { match } = await adminSubscriptionsMatch({ search: String(user._id) }, NOW, subscriptionPlanCatalog());
      const explain = (await Subscription.find(match)
        .sort({ createdAt: -1, _id: -1 })
        .limit(25)
        .explain('executionStats')) as unknown as { executionStats: { totalDocsExamined: number; nReturned: number } };

      expect(explain.executionStats.nReturned).toBe(1);
      expect(explain.executionStats.totalDocsExamined).toBeLessThan(25);
    });

    it('matches an uppercase owner id, and the org that owner is billed for', async () => {
      const user = await seedUser('jane');
      const organization = await seedOrganization('Acme', String(user._id));
      await seedSubscription(String(user._id));
      await seedSubscription(String(organization._id), { ownerType: 'Organization' });
      await seedSubscription(String((await seedUser('bob'))._id));

      const result = await listAdminSubscriptions({ ...params, search: String(user._id).toUpperCase() }, NOW);

      expect(result.subscriptions.map(row => row.ownerId).sort()).toEqual(
        [String(user._id), String(organization._id)].sort()
      );
    });

    it('reports a truncated search past OWNER_SEARCH_LIMIT matching owners', async () => {
      const users = await User.insertMany(
        Array.from({ length: OWNER_SEARCH_LIMIT + 1 }, (_, index) => ({
          name: `many${index}`,
          username: `many${index}`,
          email: `many${index}@example.com`,
        }))
      );
      await Promise.all(users.map(user => seedSubscription(String(user._id))));

      const list = await listAdminSubscriptions({ ...params, search: 'many' }, NOW);
      const summary = await adminSubscriptionsSummary({ search: 'many' }, NOW);

      expect(list).toMatchObject({ searchTruncated: true, total: OWNER_SEARCH_LIMIT });
      expect(summary).toMatchObject({ searchTruncated: true, total: OWNER_SEARCH_LIMIT });
    });

    it('matches nothing when no owner matches', async () => {
      const user = await seedUser('jane');
      await seedSubscription(String(user._id));

      const result = await listAdminSubscriptions({ ...params, search: 'nobody-here' }, NOW);

      expect(result).toMatchObject({ subscriptions: [], total: 0, totalPages: 0 });
    });
  });

  it('reports a null owner when the owner record is gone', async () => {
    await seedSubscription(String(new mongoose.Types.ObjectId()));

    const result = await listAdminSubscriptions(params, NOW);

    expect(result.subscriptions[0].owner).toBeNull();
  });
});

describe('adminSubscriptionsSummary', () => {
  const seedMix = async () => {
    const user = await seedUser('jane');
    const organization = await seedOrganization('Acme', String(user._id));
    const userId = String(user._id);
    const organizationId = String(organization._id);
    await seedSubscription(userId, { status: 'active' });
    await seedSubscription(userId, { status: 'past_due' });
    await seedSubscription(userId, { status: 'active', source: 'admin_grant', subscriptionId: 'admin_grant_a' });
    await seedSubscription(userId, {
      status: 'canceled',
      source: 'admin_grant',
      subscriptionId: 'admin_grant_b',
    });
    await seedSubscription(userId, { status: 'canceled', canceledAt: new Date(NOW.getTime() - 5 * DAY) });
    await seedSubscription(userId, { status: 'canceled', canceledAt: new Date(NOW.getTime() - 60 * DAY) });
    await seedSubscription(organizationId, { ownerType: 'Organization', status: 'active' });
  };

  it('counts each built-in view', async () => {
    await seedMix();

    const summary = await adminSubscriptionsSummary({}, NOW);

    // None of these rows carries a mirrored amount, so every paying one is counted as unpriced.
    expect(summary).toEqual({
      total: 7,
      views: { paying: 3, pastDue: 1, comped: 1, churned: 1 },
      mrr: { currency: 'usd', amount: 0, unpriced: 3, otherCurrency: 0 },
      pastDueMrr: { currency: 'usd', amount: 0, unpriced: 1, otherCurrency: 0 },
      searchTruncated: false,
    });
  });

  it('intersects the views with the current filter', async () => {
    await seedMix();

    const summary = await adminSubscriptionsSummary({ ownerType: 'Organization' }, NOW);

    expect(summary).toEqual({
      total: 1,
      views: { paying: 1, pastDue: 0, comped: 0, churned: 0 },
      mrr: { currency: 'usd', amount: 0, unpriced: 1, otherCurrency: 0 },
      pastDueMrr: { currency: 'usd', amount: 0, unpriced: 0, otherCurrency: 0 },
      searchTruncated: false,
    });
  });
});

describe('MRR', () => {
  // A Professional plan at $19.00 a month, as mirrored from Stripe.
  const professional = { unitAmount: 1900, currency: 'usd', interval: 'month', intervalCount: 1 };

  const seedBilling = async () => {
    const user = await seedUser('jane');
    const organization = await seedOrganization('Team org', String(user._id));
    const userId = String(user._id);
    await seedSubscription(userId, { subscriptionId: 'sub_monthly', ...professional });
    await seedSubscription(userId, {
      subscriptionId: 'sub_yearly',
      ...professional,
      unitAmount: 19900,
      interval: 'year',
    });
    await seedSubscription(String(organization._id), {
      subscriptionId: 'sub_team',
      ownerType: 'Organization',
      ...professional,
      unitAmount: 3000,
      quantity: 8,
    });
    await seedSubscription(userId, { subscriptionId: 'sub_past_due', status: 'past_due', ...professional });
    await seedSubscription(userId, { subscriptionId: 'sub_unpaid', status: 'unpaid', ...professional });
    await seedSubscription(userId, { subscriptionId: 'sub_trial', status: 'trialing', ...professional });
    await seedSubscription(userId, { subscriptionId: 'sub_canceled', status: 'canceled', ...professional });
    await seedSubscription(userId, { subscriptionId: 'admin_grant_c', source: 'admin_grant', ...professional });
    // Written before the mirror existed: no amount, currency or interval at all.
    await seedSubscription(userId, { subscriptionId: 'sub_unsynced' });
    await seedSubscription(userId, { subscriptionId: 'sub_tiered', ...professional, unitAmount: null });
    await seedSubscription(userId, { subscriptionId: 'sub_eur', ...professional, currency: 'eur', unitAmount: 1800 });
  };

  it('sums active and past due Stripe rows per month, counting what it leaves out', async () => {
    await seedBilling();

    const summary = await adminSubscriptionsSummary({}, NOW);

    // 1900 + 19900 / 12 + 3000 x 8 + 1900 (past due)
    expect(summary.mrr).toEqual({ currency: 'usd', amount: 29458, unpriced: 2, otherCurrency: 1 });
    expect(summary.pastDueMrr).toEqual({ currency: 'usd', amount: 1900, unpriced: 0, otherCurrency: 0 });
    expect(summary.views.pastDue).toBe(2);
  });

  it('intersects MRR with the current filter', async () => {
    await seedBilling();

    const organizations = await adminSubscriptionsSummary({ ownerType: 'Organization' }, NOW);
    const comps = await adminSubscriptionsSummary({ source: 'admin_grant' }, NOW);

    expect(organizations.mrr).toEqual({ currency: 'usd', amount: 24000, unpriced: 0, otherCurrency: 0 });
    expect(comps.mrr).toEqual({ currency: 'usd', amount: 0, unpriced: 0, otherCurrency: 0 });
  });

  it('gives the same totals when facets run as separate queries for DocumentDB', async () => {
    await seedBilling();
    const native = await adminSubscriptionsSummary({}, NOW);

    vi.stubEnv('USE_DOCUMENTDB_COMPATIBILITY', 'true');
    try {
      const split = await adminSubscriptionsSummary({}, NOW);
      expect(split).toEqual(native);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("puts each row's own MRR on the list, and none on comps or rows without an amount", async () => {
    await seedBilling();

    const result = await listAdminSubscriptions(params, NOW);
    const mrrOf = Object.fromEntries(result.subscriptions.map(row => [row.subscriptionId, row.mrr]));

    expect(mrrOf).toEqual({
      sub_monthly: { amount: 1900, currency: 'usd' },
      sub_yearly: { amount: 1658, currency: 'usd' },
      sub_team: { amount: 24000, currency: 'usd' },
      sub_past_due: { amount: 1900, currency: 'usd' },
      sub_unpaid: null,
      sub_trial: null,
      sub_canceled: null,
      admin_grant_c: null,
      sub_unsynced: null,
      sub_tiered: null,
      sub_eur: { amount: 1800, currency: 'eur' },
    });
  });

  it('carries the mirrored billing interval, and none for a row written before the mirror', async () => {
    await seedBilling();

    const result = await listAdminSubscriptions(params, NOW);
    const intervalOf = Object.fromEntries(result.subscriptions.map(row => [row.subscriptionId, row.billedInterval]));

    expect(intervalOf.sub_yearly).toEqual({ interval: 'year', intervalCount: 1 });
    expect(intervalOf.sub_monthly).toEqual({ interval: 'month', intervalCount: 1 });
    expect(intervalOf.sub_unsynced).toBeNull();
  });
});

describe('adminSubscriptionsExportPage', () => {
  it('pages newest first by keyset with no overlap, breaking a createdAt tie by _id', async () => {
    const user = await seedUser('jane');
    const tie = new Date(NOW.getTime() - 2 * DAY);
    await seedSubscription(String(user._id), { createdAt: new Date(NOW.getTime() - DAY) });
    await seedSubscription(String(user._id), { createdAt: tie });
    await seedSubscription(String(user._id), { createdAt: tie });
    await seedSubscription(String(user._id), { createdAt: new Date(NOW.getTime() - 3 * DAY) });
    const { match } = await adminSubscriptionsMatch({}, NOW, catalog);

    const first = await adminSubscriptionsExportPage(match, null, 2, catalog);
    const last = first[first.length - 1];
    const rest = await adminSubscriptionsExportPage(
      match,
      { createdAt: new Date(last.createdAt), id: last.id },
      5,
      catalog
    );

    const all = [...first, ...rest];
    expect(all).toHaveLength(4);
    expect(new Set(all.map(row => row.id)).size).toBe(4);
    const times = all.map(row => new Date(row.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const tied = all.filter(row => new Date(row.createdAt).getTime() === tie.getTime()).map(row => row.id);
    expect(tied).toEqual([...tied].sort().reverse());
  });
});

describe('cancel filter', () => {
  const seedCancels = async () => {
    const userId = String((await seedUser('jane'))._id);
    await seedSubscription(userId, { subscriptionId: 'sub_live', status: 'active' });
    await seedSubscription(userId, {
      subscriptionId: 'sub_scheduled',
      status: 'active',
      canceledAt: new Date(NOW.getTime() - 2 * DAY),
    });
    await seedSubscription(userId, {
      subscriptionId: 'sub_churned',
      status: 'canceled',
      canceledAt: new Date(NOW.getTime() - 5 * DAY),
    });
    await seedSubscription(userId, {
      subscriptionId: 'sub_churned_long_ago',
      status: 'canceled',
      canceledAt: new Date(NOW.getTime() - 60 * DAY),
    });
  };
  const subscriptionIds = (rows: { subscriptionId: string }[]) => rows.map(row => row.subscriptionId).sort();

  it('lists a scheduled cancel that has not ended yet', async () => {
    await seedCancels();

    const result = await listAdminSubscriptions({ ...params, cancel: 'scheduled' }, NOW);

    expect(subscriptionIds(result.subscriptions)).toEqual(['sub_scheduled']);
  });

  it('lists status canceled plus last30 as exactly the rows summary.views.churned counts', async () => {
    await seedCancels();

    const churned = await listAdminSubscriptions({ ...params, status: ['canceled'], cancel: 'last30' }, NOW);
    const summary = await adminSubscriptionsSummary({}, NOW);

    expect(subscriptionIds(churned.subscriptions)).toEqual(['sub_churned']);
    expect(summary.views.churned).toBe(churned.total);
  });

  it('counts a cancel filter through the summary total', async () => {
    await seedCancels();

    expect((await adminSubscriptionsSummary({ cancel: 'scheduled' }, NOW)).total).toBe(1);
  });
});
