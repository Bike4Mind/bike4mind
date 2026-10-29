import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Organization, User, mongoose } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { Subscription } from '@server/models/Subscription';
import { getAdminSubscriptionDetail } from './getAdminSubscriptionDetail';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const DAY = 86_400_000;
const NOW = Date.now();

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
const seedSubscription = (ownerId: string, fields: Record<string, unknown> = {}) =>
  Subscription.create({
    subscriptionId: `sub_${++counter}`,
    ownerType: 'User',
    ownerId,
    priceId: 'price_test',
    status: 'active',
    source: 'stripe',
    quantity: 1,
    periodStartsAt: new Date(NOW - 10 * DAY),
    periodEndsAt: new Date(NOW + 20 * DAY),
    ...fields,
  });

describe('getAdminSubscriptionDetail', () => {
  it('returns null for an id that is not an ObjectId or names nothing', async () => {
    expect(await getAdminSubscriptionDetail('not-an-id')).toBeNull();
    expect(await getAdminSubscriptionDetail(new mongoose.Types.ObjectId().toHexString())).toBeNull();
  });

  it('describes a user comp with its grant provenance, override and sibling rows', async () => {
    const user = await User.create({ name: 'jane', username: 'jane', email: 'jane@example.com', currentCredits: 42 });
    const comp = await seedSubscription(String(user._id), {
      source: 'admin_grant',
      subscriptionId: 'admin_grant_1',
      grantedBy: 'admin-1',
      grantedReason: 'design partner',
      customCreditsPerCycle: 1234,
    });
    const older = await seedSubscription(String(user._id), {
      status: 'canceled',
      createdAt: new Date(NOW - 30 * DAY),
    });

    const detail = await getAdminSubscriptionDetail(String(comp._id));

    expect(detail).toMatchObject({
      subscription: { id: String(comp._id), source: 'admin_grant', ownerType: 'User' },
      grantedBy: 'admin-1',
      grantedReason: 'design partner',
      credits: { defaultPerCycle: null, customPerCycle: 1234, effectivePerCycle: 1234, recentGrants: [] },
      ownerCredits: 42,
      seats: null,
      actingUserId: String(user._id),
    });
    expect(detail?.otherSubscriptions.map(row => row.id)).toEqual([String(older._id)]);
  });

  it('describes an organization row with seats and the billing owner as the acting user', async () => {
    const billingOwner = await User.create({ name: 'boss', username: 'boss', email: 'boss@example.com' });
    const organization = await Organization.create({
      name: 'Acme',
      userId: String(billingOwner._id),
      seats: 5,
      currentCredits: 900,
      users: [{ userId: 'm1', permissions: ['read'] }],
    });
    const row = await seedSubscription(String(organization._id), { ownerType: 'Organization', quantity: 3 });

    const detail = await getAdminSubscriptionDetail(String(row._id));

    expect(detail?.actingUserId).toBe(String(billingOwner._id));
    expect(detail?.ownerCredits).toBe(900);
    expect(detail?.grantedBy).toBeNull();
    expect(detail?.seats).toMatchObject({ paid: 3, organizationSeats: 5, members: 2 });
    expect(detail?.seats?.min).toBeGreaterThan(0);
    expect(detail?.credits.defaultPerCycle).toBeGreaterThan(0);
    expect(detail?.credits.effectivePerCycle).toBe(detail?.credits.defaultPerCycle);
  });

  it('reports a missing owner as null credits and no acting user for an organization row', async () => {
    const row = await seedSubscription(new mongoose.Types.ObjectId().toHexString(), { ownerType: 'Organization' });

    const detail = await getAdminSubscriptionDetail(String(row._id));

    expect(detail?.ownerCredits).toBeNull();
    expect(detail?.actingUserId).toBeNull();
    expect(detail?.subscription.owner).toBeNull();
  });
});
