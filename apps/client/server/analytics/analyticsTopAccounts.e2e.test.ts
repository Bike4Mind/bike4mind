import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AnalyticsUserDay, Organization } from '@bike4mind/database';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { getTopAccounts, TOP_ACCOUNTS_LIMIT } from './analyticsTopAccounts';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;
// 7d range: 2026-06-09..2026-06-15, today partial, so the tables cover 06-09..06-14.
const NOW = new Date('2026-06-15T12:00:00.000Z');
const QUERY = { range: '7d', compare: 'prev', signups: 'legit' } as const;

const oid = () => new mongoose.Types.ObjectId();
const ids = { heavy: oid(), busy: oid(), bot: oid(), banned: oid(), org: oid(), quietOrg: oid() };

const seedUser = (id: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) =>
  mongoose.connection.collection('users').insertOne({
    _id: id,
    username: String(id),
    name: `user ${String(id).slice(-4)}`,
    email: `${id}@customer.example.com`,
    level: 'DemoUser',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  });

const seedDay = (userId: mongoose.Types.ObjectId | string, day: string, extra: Record<string, unknown> = {}) =>
  AnalyticsUserDay.collection.insertOne({
    day,
    userId: String(userId),
    ownerType: 'User',
    requests: 10,
    creditsCharged: 5,
    features: ['chat'],
    sources: ['web'],
    suspected: false,
    ...extra,
  });

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await AnalyticsUserDay.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await AnalyticsUserDay.createIndexes();
});

describe('getTopAccounts', () => {
  it('ranks by active days then requests and covers complete days only', async () => {
    await seedUser(ids.heavy, { level: 'PaidUser', name: 'Heavy' });
    await seedUser(ids.busy, { name: 'Busy' });
    for (const day of ['2026-06-10', '2026-06-11', '2026-06-12']) await seedDay(ids.heavy, day);
    // More requests but fewer days ranks lower; today's row is outside the complete days.
    await seedDay(ids.busy, '2026-06-12', { requests: 500 });
    await seedDay(ids.busy, '2026-06-15', { requests: 500 });
    await seedDay(ids.busy, '2026-06-01', { requests: 500 });

    const result = await getTopAccounts(QUERY, NOW);
    expect(result.covered).toEqual({ from: '2026-06-09', to: '2026-06-14' });
    expect(result.users.map(row => [row.name, row.activeDays, row.requests, row.plan])).toEqual([
      ['Heavy', 3, 30, 'PaidUser'],
      ['Busy', 1, 500, 'DemoUser'],
    ]);
    expect(result.users[0].share).toBeCloseTo((30 / 530) * 100);
    expect(result.users[0].credits).toBe(15);
  });

  it('leaves out suspected and suspended users, from the org sums too, and counts them', async () => {
    await seedUser(ids.heavy);
    await seedUser(ids.bot);
    await seedUser(ids.banned, { isBanned: true });
    const org = { orgId: String(ids.org), ownerType: 'Organization' };
    await seedDay(ids.heavy, '2026-06-10', org);
    await seedDay(ids.bot, '2026-06-10', { ...org, suspected: true, requests: 1000 });
    await seedDay(ids.bot, '2026-06-11', { ...org, suspected: true, requests: 1000 });
    await seedDay(ids.banned, '2026-06-12', { ...org, requests: 1000 });

    const result = await getTopAccounts(QUERY, NOW);
    expect(result.users.map(row => row.id)).toEqual([String(ids.heavy)]);
    expect(result.excluded).toEqual({ suspected: 1, suspended: 1 });
    expect(result.orgs).toHaveLength(1);
    expect(result.orgs[0]).toMatchObject({ id: String(ids.org), activeDays: 1, requests: 10 });
  });

  it('counts an org day once however many members were active, and names its plan', async () => {
    await seedUser(ids.heavy);
    await seedUser(ids.busy);
    await Organization.collection.insertMany([
      { _id: ids.org, name: 'Acme', personal: false },
      { _id: ids.quietOrg, name: 'Quiet', personal: false },
    ]);
    await Subscription.collection.insertOne({
      ownerType: 'Organization',
      ownerId: String(ids.org),
      status: 'active',
      subscriptionId: 'sub_1',
    });
    const at = (orgId: mongoose.Types.ObjectId) => ({ orgId: String(orgId), ownerType: 'Organization' });
    await seedDay(ids.heavy, '2026-06-10', at(ids.org));
    await seedDay(ids.busy, '2026-06-10', at(ids.org));
    await seedDay(ids.busy, '2026-06-11', at(ids.quietOrg));

    const result = await getTopAccounts(QUERY, NOW);
    expect(result.orgs.map(row => [row.name, row.activeDays, row.requests, row.plan])).toEqual([
      ['Acme', 1, 20, 'Paid'],
      ['Quiet', 1, 10, 'Free'],
    ]);
  });

  it('keeps a user-day whose user is gone, labelled by its id, and returns at most the limit', async () => {
    for (let i = 0; i < TOP_ACCOUNTS_LIMIT + 2; i++) await seedDay(`orphan-${i}`, '2026-06-10', { requests: i });
    const result = await getTopAccounts(QUERY, NOW);
    expect(result.users).toHaveLength(TOP_ACCOUNTS_LIMIT);
    expect(result.users[0]).toMatchObject({
      id: `orphan-${TOP_ACCOUNTS_LIMIT + 1}`,
      name: `orphan-${TOP_ACCOUNTS_LIMIT + 1}`,
    });
  });

  it('returns nothing for a range with no complete day', async () => {
    const result = await getTopAccounts({ ...QUERY, range: 'custom', from: '2026-06-15', to: '2026-06-15' }, NOW);
    expect(result).toEqual({ covered: null, users: [], orgs: [], excluded: { suspected: 0, suspended: 0 } });
  });
});
