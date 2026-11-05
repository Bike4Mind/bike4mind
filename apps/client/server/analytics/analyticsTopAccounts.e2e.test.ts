import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AnalyticsDaily, AnalyticsUserDay, Organization } from '@bike4mind/database';
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

const seedRollups = (days = ['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14']) =>
  AnalyticsDaily.collection.insertMany(days.map(day => ({ day })));

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
    active: true,
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
    // 06-14 has no daily row: its rollup has not run yet.
    await AnalyticsDaily.collection.insertMany(
      ['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13'].map(day => ({ day }))
    );

    const result = await getTopAccounts(QUERY, NOW);
    expect(result.covered).toEqual({ from: '2026-06-09', to: '2026-06-14' });
    expect(result.missingDays).toEqual(['2026-06-14']);
    expect(result.users.map(row => [row.name, row.activeDays, row.requests, row.plan])).toEqual([
      ['Heavy', 3, 30, 'PaidUser'],
      ['Busy', 1, 500, 'DemoUser'],
    ]);
    expect(result.users[0].share).toBeCloseTo((30 / 530) * 100);
    expect(result.users[0].credits).toBe(15);
  });

  it('leaves out suspected and suspended users, from the org sums too, and counts them', async () => {
    await seedRollups();
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

  it('retains API-only requests, credits and shares without counting them as active days', async () => {
    await seedRollups();
    await seedUser(ids.heavy);
    await seedUser(ids.busy);
    await seedDay(ids.heavy, '2026-06-10', {
      active: false,
      sources: ['api'],
      requests: 100,
      creditsCharged: 50,
      orgs: [{ orgId: String(ids.org), requests: 100, creditsCharged: 50, active: false }],
    });
    await seedDay(ids.busy, '2026-06-10', {
      orgs: [{ orgId: String(ids.quietOrg), requests: 10, creditsCharged: 5, active: true }],
    });

    const result = await getTopAccounts(QUERY, NOW);
    expect(result.users.map(row => row.id)).toEqual([String(ids.busy), String(ids.heavy)]);
    expect(result.users[1]).toMatchObject({ activeDays: 0, requests: 100, credits: 50 });
    expect(result.users[1].share).toBeCloseTo((100 / 110) * 100);
    expect(result.orgs.map(row => row.id)).toEqual([String(ids.quietOrg), String(ids.org)]);
    expect(result.orgs[1]).toMatchObject({ activeDays: 0, requests: 100, credits: 50 });
    expect(result.orgs[1].share).toBeCloseTo((100 / 110) * 100);
  });

  it('counts only first-party activity billed to each org and combines its members once per day', async () => {
    await seedRollups();
    await seedDay(ids.heavy, '2026-06-10', {
      requests: 30,
      creditsCharged: 15,
      sources: ['web', 'api'],
      orgs: [{ orgId: String(ids.org), requests: 20, creditsCharged: 10, active: false }],
    });
    await seedDay(ids.busy, '2026-06-10', {
      requests: 6,
      creditsCharged: 3,
      orgs: [{ orgId: String(ids.quietOrg), requests: 6, creditsCharged: 3, active: true }],
    });
    await seedDay(ids.bot, '2026-06-10', {
      active: false,
      sources: ['api'],
      orgs: [{ orgId: String(ids.quietOrg), requests: 10, creditsCharged: 5, active: false }],
    });

    const { orgs } = await getTopAccounts(QUERY, NOW);
    expect(orgs.map(row => [row.id, row.activeDays, row.requests, row.credits])).toEqual([
      [String(ids.quietOrg), 1, 16, 8],
      [String(ids.org), 0, 20, 10],
    ]);
  });

  it('falls back to row activity for older org splits and counts older rows without flags', async () => {
    await seedRollups();
    await seedDay(ids.heavy, '2026-06-10', { orgId: String(ids.org) });
    await AnalyticsUserDay.collection.updateOne({ userId: String(ids.heavy) }, { $unset: { active: '' } });
    await seedDay(ids.busy, '2026-06-11', {
      active: false,
      sources: ['api'],
      orgs: [{ orgId: String(ids.quietOrg), requests: 10, creditsCharged: 5 }],
    });

    const result = await getTopAccounts(QUERY, NOW);
    expect(result.users.map(row => [row.id, row.activeDays, row.requests])).toEqual([
      [String(ids.heavy), 1, 10],
      [String(ids.busy), 0, 10],
    ]);
    expect(result.orgs.map(row => [row.id, row.activeDays, row.requests])).toEqual([
      [String(ids.org), 1, 10],
      [String(ids.quietOrg), 0, 10],
    ]);
  });

  it('counts an org day once however many members were active, and names its plan', async () => {
    await seedRollups();
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

  it('credits each org with only the usage billed to it', async () => {
    await seedRollups();
    await seedUser(ids.heavy);
    await seedUser(ids.busy);
    await Organization.collection.insertMany([
      { _id: ids.org, name: 'Acme', personal: false },
      { _id: ids.quietOrg, name: 'Quiet', personal: false },
    ]);
    // 200 personal requests, 1 in Acme and 3 in Quiet on the same day.
    await seedDay(ids.heavy, '2026-06-10', {
      ownerType: 'User',
      orgId: String(ids.quietOrg),
      requests: 204,
      creditsCharged: 408,
      orgs: [
        { orgId: String(ids.quietOrg), requests: 3, creditsCharged: 6 },
        { orgId: String(ids.org), requests: 1, creditsCharged: 2 },
      ],
    });
    // Purely personal: no org gets anything.
    await seedDay(ids.busy, '2026-06-11', { requests: 50, orgs: [] });

    const result = await getTopAccounts(QUERY, NOW);
    expect(result.orgs.map(row => [row.name, row.activeDays, row.requests, row.credits])).toEqual([
      ['Quiet', 1, 3, 6],
      ['Acme', 1, 1, 2],
    ]);
  });

  it('credits a row rolled up before the per-org split to its top org, whole', async () => {
    await seedRollups();
    await Organization.collection.insertOne({ _id: ids.org, name: 'Acme', personal: false });
    await seedDay(ids.heavy, '2026-06-10', { ownerType: 'Organization', orgId: String(ids.org) });
    const result = await getTopAccounts(QUERY, NOW);
    expect(result.orgs.map(row => [row.name, row.requests, row.credits])).toEqual([['Acme', 10, 5]]);
  });

  it('leaves out usage on a covered day the daily rollup has not reached', async () => {
    await seedUser(ids.heavy);
    await Organization.collection.insertOne({ _id: ids.org, name: 'Acme', personal: false });
    await seedRollups(['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13']);
    await seedDay(ids.heavy, '2026-06-10', { orgId: String(ids.org) });
    await seedDay(ids.heavy, '2026-06-14', { orgId: String(ids.org), requests: 900 });

    const result = await getTopAccounts(QUERY, NOW);
    expect(result.missingDays).toEqual(['2026-06-14']);
    expect(result.users.map(row => [row.activeDays, row.requests])).toEqual([[1, 10]]);
    expect(result.orgs.map(row => [row.activeDays, row.requests])).toEqual([[1, 10]]);
  });

  it('reports every covered day as missing and ranks nothing when no daily row exists', async () => {
    await seedDay(ids.heavy, '2026-06-10');
    const result = await getTopAccounts(QUERY, NOW);
    expect(result.missingDays).toHaveLength(6);
    expect(result.users).toEqual([]);
    expect(result.orgs).toEqual([]);
  });

  it('gives an org that no longer exists no plan', async () => {
    await seedRollups();
    await seedDay(ids.heavy, '2026-06-10', { orgId: String(ids.org) });
    expect((await getTopAccounts(QUERY, NOW)).orgs[0]).toMatchObject({
      name: String(ids.org),
      plan: null,
      known: false,
    });
  });

  it('labels a user without a name by username before email', async () => {
    await seedRollups();
    await seedUser(ids.heavy, { name: '', username: 'heavy-handle' });
    await seedDay(ids.heavy, '2026-06-10');
    expect((await getTopAccounts(QUERY, NOW)).users[0]).toMatchObject({ name: 'heavy-handle', known: true });
  });

  it('keeps a user-day whose user is gone, labelled by its id, and returns at most the limit', async () => {
    await seedRollups();
    for (let i = 0; i < TOP_ACCOUNTS_LIMIT + 2; i++) await seedDay(`orphan-${i}`, '2026-06-10', { requests: i });
    const result = await getTopAccounts(QUERY, NOW);
    expect(result.users).toHaveLength(TOP_ACCOUNTS_LIMIT);
    expect(result.users[0]).toMatchObject({
      id: `orphan-${TOP_ACCOUNTS_LIMIT + 1}`,
      name: `orphan-${TOP_ACCOUNTS_LIMIT + 1}`,
      known: false,
    });
  });

  it('returns nothing for a range with no complete day', async () => {
    const result = await getTopAccounts({ ...QUERY, range: 'custom', from: '2026-06-15', to: '2026-06-15' }, NOW);
    expect(result).toEqual({
      covered: null,
      missingDays: [],
      users: [],
      orgs: [],
      excluded: { suspected: 0, suspended: 0 },
    });
  });
});
