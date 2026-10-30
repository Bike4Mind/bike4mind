import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyStatus, CreditHolderType } from '@bike4mind/common';
import { AnalyticsUserDay, CreditTransaction, Organization, User, UserApiKey } from '@bike4mind/database';
import { Subscription } from '@server/models/Subscription';
import { FUNNEL_COHORT_MAX } from '@server/analytics/activationFunnel';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import {
  ACTIVE_USERS_MAX,
  USERS_EXPORT_MAX_ROWS,
  adminUsersDomainGroups,
  adminUsersSummary,
  exportAdminUsers,
  listAdminUsers,
} from './listAdminUsers';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;
const NOW = new Date('2026-06-15T12:00:00Z');
const DAY = 86_400_000;
const viewer = { userId: 'a'.repeat(24), isAdmin: true };
const logError = vi.fn();
const params = { page: 1, limit: 25, sortField: 'createdAt', sortOrder: 'desc' } as const;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
beforeEach(() => {
  vi.restoreAllMocks();
  logError.mockReset();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const seedUser = (name: string, fields: Record<string, unknown> = {}) =>
  User.create({ name, username: name, email: `${name}@example.com`, ...fields });

const seedKey = (userId: string, keyPrefix: string, status: ApiKeyStatus) =>
  UserApiKey.collection.insertOne({ userId, name: keyPrefix, keyPrefix, status, scopes: [] });

const seedSpend = (ownerId: string, credits: number, createdAt: Date, type = 'text_generation_usage') =>
  CreditTransaction.collection.insertOne({
    ownerId,
    ownerType: CreditHolderType.User,
    credits,
    type,
    createdAt,
    updatedAt: createdAt,
  });

describe('listAdminUsers', () => {
  it('paginates newest first and reports the total from the facet', async () => {
    for (let i = 0; i < 5; i++) await seedUser(`user${i}`, { createdAt: new Date(NOW.getTime() - i * DAY) });

    const page2 = await listAdminUsers({ ...params, page: 2, limit: 2 }, viewer, { logError }, NOW);

    expect(page2.totalUsers).toBe(5);
    expect(page2.totalPages).toBe(3);
    expect(page2.page).toBe(2);
    expect(page2.users.map(user => user.username)).toEqual(['user2', 'user3']);
  });

  it('returns an empty page with zero totals when nothing matches', async () => {
    const result = await listAdminUsers({ ...params, search: 'nobody' }, viewer, { logError }, NOW);
    expect(result).toEqual({ users: [], totalUsers: 0, page: 1, totalPages: 0 });
  });

  it('populates the organization on each row', async () => {
    const org = await Organization.create({ name: 'Acme Corp', userId: viewer.userId });
    await seedUser('member', { organizationId: org._id });
    await seedUser('loner');

    const { users } = await listAdminUsers(params, viewer, { logError }, NOW);

    const member = users.find(user => user.username === 'member');
    expect(member?.organizationId).toMatchObject({ name: 'Acme Corp' });
    expect(users.find(user => user.username === 'loner')?.organizationId).toBeFalsy();
  });

  it('sums 30 day AI spend per user and falls back to 0 with no ledger rows', async () => {
    const spender = await seedUser('spender');
    await seedUser('idle');
    const id = String(spender._id);
    await seedSpend(id, -30, new Date(NOW.getTime() - 2 * DAY));
    await seedSpend(id, -12, new Date(NOW.getTime() - 5 * DAY));
    await seedSpend(id, -999, new Date(NOW.getTime() - 40 * DAY));
    await seedSpend(id, -500, new Date(NOW.getTime() - DAY), 'transfer_credit');

    const { users } = await listAdminUsers(params, viewer, { logError }, NOW);

    expect(users.find(user => user.username === 'spender')?.spend30d).toBe(42);
    expect(users.find(user => user.username === 'idle')?.spend30d).toBe(0);
  });

  it('returns null spend and logs when the ledger read fails', async () => {
    await seedUser('someone');
    vi.spyOn(CreditTransaction, 'aggregate').mockRejectedValue(new Error('ledger down'));

    const { users } = await listAdminUsers(params, viewer, { logError }, NOW);

    expect(users[0].spend30d).toBeNull();
    expect(logError).toHaveBeenCalledWith('Users list spend lookup failed', expect.any(Error));
  });

  it('counts live API keys per user and ignores disabled ones', async () => {
    const keyed = await seedUser('keyed');
    const revoked = await seedUser('revoked');
    await seedKey(String(keyed._id), 'k1', ApiKeyStatus.ACTIVE);
    await seedKey(String(keyed._id), 'k2', ApiKeyStatus.ACTIVE);
    await seedKey(String(keyed._id), 'k3', ApiKeyStatus.DISABLED);
    await seedKey(String(revoked._id), 'k4', ApiKeyStatus.DISABLED);

    const { users } = await listAdminUsers(params, viewer, { logError }, NOW);

    expect(users.find(user => user.username === 'keyed')?.apiKeyCount).toBe(2);
    expect(users.find(user => user.username === 'revoked')?.apiKeyCount).toBe(0);
  });

  it('takes the signup method from the first auth provider, else email', async () => {
    await seedUser('linked', {
      authProviders: [
        { strategy: 'github', id: 'gh-1' },
        { strategy: 'google', id: 'g-1' },
      ],
    });
    await seedUser('plain');

    const { users } = await listAdminUsers(params, viewer, { logError }, NOW);

    expect(users.find(user => user.username === 'linked')?.signupMethod).toBe('github');
    expect(users.find(user => user.username === 'plain')?.signupMethod).toBe('email');
    expect(JSON.stringify(users)).not.toContain('gh-1');
  });

  it('filters by hasApiKey, treating a user with only a disabled key as keyless', async () => {
    const live = await seedUser('live');
    const dead = await seedUser('dead');
    await seedUser('none');
    await seedKey(String(live._id), 'k1', ApiKeyStatus.ACTIVE);
    await seedKey(String(dead._id), 'k2', ApiKeyStatus.DISABLED);

    const withKey = await listAdminUsers({ ...params, hasApiKey: 'yes' }, viewer, { logError }, NOW);
    const withoutKey = await listAdminUsers({ ...params, hasApiKey: 'no' }, viewer, { logError }, NOW);

    expect(withKey.users.map(user => user.username)).toEqual(['live']);
    expect(withKey.totalUsers).toBe(1);
    expect(withoutKey.users.map(user => user.username).sort()).toEqual(['dead', 'none']);
  });

  it('selects the same key holders on the list, export and domain groups in DocumentDB mode', async () => {
    const live = await seedUser('live');
    const dead = await seedUser('dead');
    await seedKey(String(live._id), 'k1', ApiKeyStatus.ACTIVE);
    await seedKey(String(dead._id), 'k2', ApiKeyStatus.DISABLED);
    // The domain groups read hints createdAt indexes on both collections; autoIndex may not have built them.
    await Promise.all([User.createIndexes(), UserApiKey.createIndexes()]);
    vi.stubEnv('USE_DOCUMENTDB_COMPATIBILITY', 'true');
    try {
      const list = await listAdminUsers({ ...params, hasApiKey: 'yes' }, viewer, { logError }, NOW);
      const exported = await exportAdminUsers({ hasApiKey: 'yes' }, NOW);
      const grouped = await adminUsersDomainGroups({ hasApiKey: 'yes' }, NOW);

      expect(list.users.map(user => user.username)).toEqual(['live']);
      expect(exported.users.map(user => user.username)).toEqual(['live']);
      expect(grouped.groups.flatMap(group => group.userIds)).toEqual([String(live._id)]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('analytics drill-down filters', () => {
  const seedActiveDay = (userId: unknown, day: string) =>
    AnalyticsUserDay.collection.insertOne({ day, userId: String(userId), ownerType: 'User', suspected: false });
  const usernames = (result: { users: { username?: string }[] }) => result.users.map(user => user.username).sort();

  it('filters to users with rolled-up activity in the inclusive active window', async () => {
    const early = await seedUser('early');
    const late = await seedUser('late');
    const before = await seedUser('before');
    await seedUser('idle');
    await seedActiveDay(early._id, '2026-06-01');
    await seedActiveDay(late._id, '2026-06-05');
    await seedActiveDay(late._id, '2026-06-03');
    await seedActiveDay(before._id, '2026-05-31');

    const week = await listAdminUsers(
      { ...params, activeFrom: '2026-06-01', activeTo: '2026-06-05' },
      viewer,
      { logError },
      NOW
    );
    const day = await exportAdminUsers({ activeFrom: '2026-06-05', activeTo: '2026-06-05' }, NOW);

    expect(usernames(week)).toEqual(['early', 'late']);
    expect(week.totalUsers).toBe(2);
    expect(day.users.map(user => user.username)).toEqual(['late']);
  });

  it('exports only the users active in the window', async () => {
    const early = await seedUser('early');
    const late = await seedUser('late');
    const before = await seedUser('before');
    await seedUser('idle');
    await seedActiveDay(early._id, '2026-06-01');
    await seedActiveDay(late._id, '2026-06-05');
    await seedActiveDay(before._id, '2026-05-31');

    const { users, truncated } = await exportAdminUsers({ activeFrom: '2026-06-01', activeTo: '2026-06-05' }, NOW);

    expect(users.map(user => user.username).sort()).toEqual(['early', 'late']);
    expect(truncated).toBe(false);
  });

  it('refuses an active window holding more users than it can resolve', async () => {
    await AnalyticsUserDay.createIndexes();
    await AnalyticsUserDay.collection.insertMany(
      Array.from({ length: ACTIVE_USERS_MAX + 1 }, (_, i) => ({
        day: '2026-06-01',
        userId: `active${i}`,
        ownerType: 'User',
        suspected: false,
      }))
    );
    const active = { activeFrom: '2026-06-01', activeTo: '2026-06-05' };

    await expect(listAdminUsers({ ...params, ...active }, viewer, { logError }, NOW)).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/Narrow the active range/),
    });
    await expect(exportAdminUsers(active, NOW)).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/Narrow the active range/),
    });
  });

  it('filters a created window to the users whose furthest funnel step is the one asked for', async () => {
    await Promise.all([User.createIndexes(), AnalyticsUserDay.createIndexes()]);
    const signup = new Date('2026-05-10T10:00:00Z');
    const seedJourney = async (name: string, activeDays: string[], fields: Record<string, unknown> = {}) => {
      const user = await seedUser(name, { createdAt: signup, ...fields });
      for (const day of activeDays) await seedActiveDay(user._id, day);
      return String(user._id);
    };
    const seedSubscription = (ownerType: 'User' | 'Organization', ownerId: string, fields: Record<string, unknown>) =>
      Subscription.collection.insertOne({
        ownerType,
        ownerId,
        subscriptionId: `sub_${ownerId}`,
        priceId: 'price_1',
        status: 'active',
        source: 'stripe',
        quantity: 1,
        periodStartsAt: signup,
        periodEndsAt: new Date('2026-07-10T00:00:00Z'),
        createdAt: new Date('2026-05-20T00:00:00Z'),
        ...fields,
      });

    await seedJourney('neverUsed', ['2026-05-18']);
    await seedJourney('triedOnce', ['2026-05-10']);
    await seedJourney('returned', ['2026-05-10', '2026-05-17']);
    const packBuyer = await seedJourney('packBuyer', ['2026-05-10', '2026-05-11']);
    await seedSpend(packBuyer, 500, new Date('2026-06-09T23:00:00Z'), 'purchase');
    await CreditTransaction.updateMany({ ownerId: packBuyer }, { $set: { status: 'completed' } });
    const latePayer = await seedJourney('latePayer', ['2026-05-10', '2026-05-11']);
    await seedSpend(latePayer, 500, new Date('2026-06-10T00:00:00Z'), 'purchase');
    await CreditTransaction.updateMany({ ownerId: latePayer }, { $set: { status: 'completed' } });
    const teamOwner = await seedJourney('teamOwner', ['2026-05-11']);
    const team = await Organization.create({ name: 'Team', userId: teamOwner });
    await seedSubscription('Organization', String(team._id), {});
    const comped = await seedJourney('comped', ['2026-05-12']);
    await seedSubscription('User', comped, { source: 'admin_grant', subscriptionId: 'admin_grant_x' });
    const abandoned = await seedJourney('abandoned', ['2026-05-12']);
    await seedSubscription('User', abandoned, { status: 'incomplete_expired' });
    await seedJourney('staffer', [], { isAdmin: true });
    await seedUser('tooNew', { createdAt: new Date('2026-06-10T00:00:00Z') });
    await seedUser('outside', { createdAt: new Date('2026-04-20T00:00:00Z') });

    const window = { createdFrom: '2026-05-01T00:00:00.000Z', createdTo: '2026-06-15T00:00:00.000Z' };
    const step = async (funnelStep: 'signedUp' | 'firstAction' | 'cameBack' | 'paid') =>
      usernames(await listAdminUsers({ ...params, ...window, funnelStep }, viewer, { logError }, NOW));

    expect(await step('signedUp')).toEqual(['neverUsed']);
    expect(await step('firstAction')).toEqual(['triedOnce']);
    expect(await step('cameBack')).toEqual(['abandoned', 'comped', 'latePayer', 'returned']);
    expect(await step('paid')).toEqual(['packBuyer', 'teamOwner']);
  });

  it('filters a created window to its suspected or legit signups, leaving internal accounts out', async () => {
    await Promise.all([User.createIndexes(), UserApiKey.createIndexes()]);
    for (let i = 0; i < 12; i++) {
      await seedUser(`burst${i}`, {
        email: `burst${i}@burst.example.net`,
        createdAt: new Date(`2026-06-03T09:${String(10 + i).padStart(2, '0')}:00Z`),
        lastActiveAt: new Date('2026-06-05T09:00:00Z'),
      });
    }
    await seedUser('regular', {
      email: 'regular@customer.example.org',
      createdAt: new Date('2026-06-02T12:00:00Z'),
      lastActiveAt: new Date('2026-06-06T12:00:00Z'),
    });
    await seedUser('staffer', {
      email: 'staffer@customer.example.org',
      createdAt: new Date('2026-06-02T13:00:00Z'),
      lastActiveAt: new Date('2026-06-06T12:00:00Z'),
      isAdmin: true,
    });
    const window = { createdFrom: '2026-06-01T00:00:00.000Z', createdTo: '2026-06-08T00:00:00.000Z' };

    const suspected = await listAdminUsers({ ...params, ...window, verdict: 'suspected' }, viewer, { logError }, NOW);
    const legit = await listAdminUsers({ ...params, ...window, verdict: 'legit' }, viewer, { logError }, NOW);
    const grouped = await adminUsersDomainGroups({ ...window, verdict: 'suspected' }, NOW);

    expect(suspected.totalUsers).toBe(12);
    expect(usernames(legit)).toEqual(['regular']);
    expect(grouped.groups.map(group => group.domain)).toEqual(['burst.example.net']);
  });

  it('refuses a funnel or verdict window holding more signups than it can resolve', async () => {
    await Promise.all([User.createIndexes(), UserApiKey.createIndexes()]);
    await User.collection.insertMany(
      Array.from({ length: FUNNEL_COHORT_MAX + 1 }, (_, i) => ({
        username: `bulk${i}`,
        createdAt: new Date(Date.UTC(2026, 4, 2) + i * 60_000),
      }))
    );
    const window = { createdFrom: '2026-05-01T00:00:00.000Z', createdTo: '2026-06-01T00:00:00.000Z' };

    await expect(
      listAdminUsers({ ...params, ...window, funnelStep: 'signedUp' }, viewer, { logError }, NOW)
    ).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/Narrow the created range/) });
    await expect(exportAdminUsers({ ...window, verdict: 'legit' }, NOW)).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/Narrow the created range/),
    });
  });
});

describe('exportAdminUsers', () => {
  it('joins organization names and derives login figures', async () => {
    const org = await Organization.create({ name: 'Acme Corp', userId: viewer.userId });
    await seedUser('member', { organizationId: org._id });
    await seedUser('loner');

    const { users, truncated } = await exportAdminUsers({}, NOW);

    expect(truncated).toBe(false);
    expect(users.find(user => user.username === 'member')).toMatchObject({
      organizationName: 'Acme Corp',
      loginCount: 0,
      lastLoginAt: null,
    });
    expect(users.find(user => user.username === 'loner')?.organizationName).toBeNull();
  });

  it('flags truncation and drops the overflow row when the filter matches more than the cap', async () => {
    const total = USERS_EXPORT_MAX_ROWS + 1;
    await User.collection.insertMany(
      Array.from({ length: total }, (_, i) => ({
        name: `u${i}`,
        username: `u${i}`,
        email: `u${i}@example.com`,
        createdAt: new Date(NOW.getTime() - i * 1000),
      }))
    );

    const { users, truncated } = await exportAdminUsers({}, NOW);

    expect(truncated).toBe(true);
    expect(users).toHaveLength(USERS_EXPORT_MAX_ROWS);
    expect(users[0].username).toBe('u0');
  });
});

describe('adminUsersDomainGroups', () => {
  it('groups the filtered users by email domain', async () => {
    // The domain context read hints the createdAt index, which autoIndex may not have built yet.
    await User.createIndexes();
    await seedUser('a1', { email: 'a1@alpha.test', createdAt: NOW });
    await seedUser('a2', { email: 'a2@alpha.test', createdAt: NOW });
    await seedUser('b1', { email: 'b1@beta.test', createdAt: NOW });

    const result = await adminUsersDomainGroups({ emailDomain: 'alpha.test' }, NOW);

    expect(result.groupsTruncated).toBe(false);
    expect(result.keysTruncated).toBe(false);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ domain: 'alpha.test' });
    expect(result.groups[0].userIds).toHaveLength(2);
  });
});

describe('adminUsersSummary', () => {
  it('counts totals, recent activity and the built-in views', async () => {
    const recent = new Date(NOW.getTime() - DAY);
    const old = new Date(NOW.getTime() - 30 * DAY);
    await seedUser('fresh', { createdAt: recent, lastActiveAt: recent });
    await seedUser('banned', { createdAt: old, isBanned: true });
    await seedUser('risky', { createdAt: old, signupGrantAssessment: { band: 'review' } });
    await seedUser('stale', { createdAt: old, lastActiveAt: old });

    const summary = await adminUsersSummary(NOW);

    expect(summary).toEqual({
      total: 4,
      activeThisWeek: 1,
      views: { newThisWeek: 1, highRisk: 1, suspended: 1 },
    });
  });
});
