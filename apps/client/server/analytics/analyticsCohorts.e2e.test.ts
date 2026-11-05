import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AnalyticsDaily, AnalyticsUserDay, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { rollupDay, shiftDay } from './analyticsRollup';
import { getAnalyticsCohorts } from './analyticsCohorts';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;
const originalDomains = process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
// Monday. Yesterday, Sunday 2026-06-14, closes the week of 2026-06-08, so with weeks: 3 the cohorts are
// the signup weeks of 05-25, 06-01 and 06-08.
const NOW = new Date('2026-06-15T12:00:00.000Z');
const AS_OF = '2026-06-14';
const FIRST_DAY = '2026-05-25';
const COHORT_STARTS = ['2026-05-25', '2026-06-01', '2026-06-08'];

const oid = () => new mongoose.Types.ObjectId();
const users = { a: oid(), b: oid(), c: oid(), d: oid(), admin: oid() };

const seedUser = (id: mongoose.Types.ObjectId, createdAt: string, extra: Record<string, unknown> = {}) =>
  mongoose.connection.collection('users').insertOne({
    _id: id,
    username: String(id),
    email: `${id}@customer.example.com`,
    createdAt: new Date(createdAt),
    ...extra,
  });

const seedEvent = (userId: mongoose.Types.ObjectId, at: string) =>
  UsageEvent.collection.insertOne({
    requestId: String(oid()),
    userId: String(userId),
    ownerId: String(userId),
    ownerType: 'User',
    feature: 'chat',
    provider: 'p',
    model: 'gpt-4.1',
    costUsd: 0.01,
    creditsCharged: 2,
    status: 'ok',
    source: 'web',
    createdAt: new Date(at),
  });

/** Every UTC day in [from, to], inclusive. */
const daysBetween = (from: string, to: string): string[] => {
  const days: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) days.push(day);
  return days;
};

/** The percents of the first `count` cells, with a blank cell as null (never undefined, never 0). */
const percents = (cells: ({ percent: number } | null)[], count: number) =>
  cells.slice(0, count).map(cell => (cell ? cell.percent : null));

const rollupThroughAsOf = async () => {
  for (const day of daysBetween(FIRST_DAY, AS_OF)) await rollupDay(day, { now: NOW });
};

/**
 * The expected cell, straight from `users` and `usageevents` and not from the rollup collections: the
 * counted users created in the cohort week, and how many of them have an event in the later week.
 */
async function directCell(cohortStart: string, offset: number) {
  const cohortEnd = shiftDay(cohortStart, 7);
  const cohort = await User.find({
    createdAt: { $gte: new Date(`${cohortStart}T00:00:00Z`), $lt: new Date(`${cohortEnd}T00:00:00Z`) },
    isAdmin: { $ne: true },
  })
    .select('_id')
    .lean();
  const ids = cohort.map(user => String(user._id));
  const weekStart = shiftDay(cohortStart, 7 * offset);
  const active = await UsageEvent.distinct('userId', {
    status: 'ok',
    userId: { $in: ids },
    createdAt: {
      $gte: new Date(`${weekStart}T00:00:00Z`),
      $lt: new Date(`${shiftDay(weekStart, 7)}T00:00:00Z`),
    },
  });
  return { size: ids.length, active: active.length };
}

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await AnalyticsUserDay.createIndexes();
  await AnalyticsDaily.createIndexes();
  await User.createIndexes();
  await UserApiKey.createIndexes();
  process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = 'staff.example.com';
});

afterAll(async () => {
  if (originalDomains === undefined) delete process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
  else process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = originalDomains;
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    UsageEvent.deleteMany({}),
    AnalyticsUserDay.deleteMany({}),
    AnalyticsDaily.deleteMany({}),
    User.deleteMany({}),
    UserApiKey.deleteMany({}),
  ]);
  // Cohort 0 (week of 05-25): a, b and an admin. Cohort 1 (06-01): c. Cohort 2 (06-08): d.
  await seedUser(users.a, '2026-05-26T08:00:00Z');
  await seedUser(users.b, '2026-05-27T08:00:00Z');
  await seedUser(users.admin, '2026-05-26T08:00:00Z', { isAdmin: true });
  await seedUser(users.c, '2026-06-02T08:00:00Z');
  await seedUser(users.d, '2026-06-09T08:00:00Z');
  await seedEvent(users.a, '2026-05-26T10:00:00Z'); // week 0 of cohort 0
  await seedEvent(users.a, '2026-06-02T10:00:00Z'); // week 1
  await seedEvent(users.b, '2026-05-27T10:00:00Z'); // week 0 only
  await seedEvent(users.admin, '2026-05-26T11:00:00Z'); // never counted
  await seedEvent(users.admin, '2026-06-02T11:00:00Z');
  await seedEvent(users.c, '2026-06-03T10:00:00Z'); // week 0 of cohort 1
  await seedEvent(users.c, '2026-06-10T10:00:00Z'); // week 1
  await seedEvent(users.d, '2026-06-09T10:00:00Z'); // week 0 of cohort 2
});

describe('getAnalyticsCohorts', () => {
  it('returns no cohorts before anything has been rolled up', async () => {
    const result = await getAnalyticsCohorts({ weeks: 3, signups: 'all' }, NOW);
    expect(result).toMatchObject({ asOf: null, cohorts: [], missingDays: [] });
  });

  it('matches a direct query of users and usageevents for every cohort cell', async () => {
    await rollupThroughAsOf();
    const result = await getAnalyticsCohorts({ weeks: 3, signups: 'all' }, NOW);

    expect(result.asOf).toBe(AS_OF);
    expect(result.missingDays).toEqual([]);
    expect(result.cohorts.map(cohort => cohort.week)).toEqual(COHORT_STARTS);

    for (const [index, start] of COHORT_STARTS.entries()) {
      const cohort = result.cohorts[index];
      for (let offset = 0; offset < 9; offset++) {
        const cell = cohort.cells[offset];
        const weekEnds = shiftDay(start, 7 * offset + 6);
        if (weekEnds > AS_OF) {
          expect(cell, `cohort ${start} week ${offset} is in the future`).toBeNull();
          continue;
        }
        const direct = await directCell(start, offset);
        expect(cohort.size, `cohort ${start} size`).toBe(direct.size);
        expect(cell, `cohort ${start} week ${offset}`).toEqual({
          active: direct.active,
          percent: (direct.active / direct.size) * 100,
        });
      }
    }
  });

  it('reads the sample cohort the way the issue describes: sizes 2, 1, 1 and the known percents', async () => {
    await rollupThroughAsOf();
    const { cohorts } = await getAnalyticsCohorts({ weeks: 3, signups: 'all' }, NOW);
    expect(cohorts.map(cohort => cohort.size)).toEqual([2, 1, 1]);
    // a and b are active in week 0, only a in week 1, nobody in week 2 (the admin is never counted).
    expect(percents(cohorts[0].cells, 3)).toEqual([100, 50, 0]);
    expect(percents(cohorts[1].cells, 3)).toEqual([100, 100, null]);
    expect(percents(cohorts[2].cells, 2)).toEqual([100, null]);
    // Future cells are blank, not zero.
    expect(cohorts[0].cells.slice(3)).toEqual(Array(6).fill(null));
  });

  it('never reads past the last complete day, so today is not in the table', async () => {
    await rollupThroughAsOf();
    await rollupDay('2026-06-15', { now: NOW });
    expect(await AnalyticsDaily.countDocuments({ day: '2026-06-15' })).toBe(1);
    const result = await getAnalyticsCohorts({ weeks: 3, signups: 'all' }, NOW);
    expect(result.asOf).toBe(AS_OF);
    expect(result.cohorts.map(cohort => cohort.week)).toEqual(COHORT_STARTS);
  });

  it('honors the Signups toggle on both the size and the active users', async () => {
    await rollupThroughAsOf();
    // Flag user c as a suspected signup the way the rollup stores it: on the daily signup count and on
    // every user-day row. The rollup's own verdicts are not the subject here, the toggle is.
    await AnalyticsUserDay.updateMany({ userId: String(users.c) }, { $set: { suspected: true } });
    await AnalyticsDaily.updateOne(
      { day: '2026-06-02' },
      { $set: { 'signups.legit': 0, 'signups.suspected': 1, 'signups.unclassified': 0 } }
    );

    const legit = await getAnalyticsCohorts({ weeks: 3, signups: 'legit' }, NOW);
    expect(legit.cohorts.map(cohort => cohort.size)).toEqual([2, 0, 1]);
    expect(legit.cohorts[1].cells).toEqual(Array(9).fill(null));
    expect(percents(legit.cohorts[0].cells, 3)).toEqual([100, 50, 0]);

    const all = await getAnalyticsCohorts({ weeks: 3, signups: 'all' }, NOW);
    expect(all.cohorts.map(cohort => cohort.size)).toEqual([2, 1, 1]);
    expect(percents(all.cohorts[1].cells, 2)).toEqual([100, 100]);
  });

  it('blanks the cohort and reports the day when a rollup day is missing', async () => {
    await rollupThroughAsOf();
    await AnalyticsDaily.deleteOne({ day: '2026-06-03' });
    const result = await getAnalyticsCohorts({ weeks: 3, signups: 'all' }, NOW);
    expect(result.missingDays).toEqual(['2026-06-03']);
    // 06-03 sits in cohort 1's signup week, so its size is unknown and so is every cell of its row.
    expect(result.cohorts[1].size).toBeNull();
    expect(result.cohorts[1].cells).toEqual(Array(9).fill(null));
    // Cohort 0's week 1 (06-01 to 06-07) contains the gap, so that cell is blank too; its week 0 is not.
    expect(result.cohorts[0].cells[0]).not.toBeNull();
    expect(result.cohorts[0].cells[1]).toBeNull();
    expect(result.cohorts[2].size).toBe(1);
  });
});
