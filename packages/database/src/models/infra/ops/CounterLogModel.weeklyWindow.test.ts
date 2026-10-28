import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { CounterLog, counterLogRepository } from './CounterLogModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  // findAllWithUserByDateRange hints the datetime index; the query fails if it is not built yet.
  await CounterLog.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await CounterLog.deleteMany({});
  await mongoose.connection.collection('users').deleteMany({});
});

// ISO week under report: Monday 2026-06-01 .. Sunday 2026-06-07 (UTC).
const WEEK_START = '2026-06-01';
const WEEK_END = '2026-06-07';
const ORG = 'org-under-test';

async function seedUser(email: string) {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('users').insertOne({ _id, email });
  return _id.toString();
}

function logAt(userId: string, iso: string) {
  return {
    userId,
    userName: userId,
    userLevel: 'free',
    userOrganization: ORG,
    counterName: 'Model Started',
    counterValue: 1,
    datetime: new Date(iso),
  };
}

const countOf = (facet: Array<{ _id: string; count: number }> | undefined, name = 'Model Started') =>
  facet?.find(row => row._id === name)?.count ?? 0;

/**
 * This week: 6 events on Mon, Wed and Sat, none on Sunday (the old code counted only Sunday).
 * Last week (2026-05-25 .. 05-31): 4 events, one on its Sunday's last millisecond.
 * The 4 weeks before this week (2026-05-04 .. 05-31): last week's 4 plus 4 on 2026-05-10.
 * The 4 weeks before those (2026-04-06 .. 05-03): 2 events.
 */
async function seedWeeks() {
  const alice = await seedUser('alice@example.com');
  const bob = await seedUser('bob@example.com');

  await CounterLog.insertMany([
    // This week
    logAt(alice, '2026-06-01T00:00:00.000Z'),
    logAt(alice, '2026-06-01T09:00:00.000Z'),
    logAt(bob, '2026-06-03T10:00:00.000Z'),
    logAt(bob, '2026-06-03T11:00:00.000Z'),
    logAt(bob, '2026-06-03T12:00:00.000Z'),
    logAt(alice, '2026-06-06T23:30:00.000Z'),
    // Last week
    logAt(alice, '2026-05-25T08:00:00.000Z'),
    logAt(alice, '2026-05-27T08:00:00.000Z'),
    logAt(alice, '2026-05-27T09:00:00.000Z'),
    logAt(bob, '2026-05-31T23:59:59.999Z'),
    // Earlier in the 4-week baseline
    ...Array.from({ length: 4 }, () => logAt(bob, '2026-05-10T12:00:00.000Z')),
    // The 4 weeks before the baseline
    logAt(alice, '2026-04-06T00:00:00.000Z'),
    logAt(alice, '2026-05-03T23:59:59.999Z'),
    // Outside every window
    logAt(alice, '2026-06-08T00:00:00.000Z'),
    logAt(alice, '2026-04-05T23:59:59.999Z'),
  ]);

  return { alice, bob };
}

describe('CounterLogRepository.metricsByDate - weekly report window', () => {
  it('counts every event from Monday 00:00 to Sunday 23:59:59.999 UTC as this week', async () => {
    await seedWeeks();

    const [result] = await counterLogRepository.metricsByDate(WEEK_END, WEEK_START);

    expect(countOf(result.thisWeek)).toBe(6);
  });

  it('compares with the same Monday-Sunday window one week earlier', async () => {
    await seedWeeks();

    const [result] = await counterLogRepository.metricsByDate(WEEK_END, WEEK_START);

    expect(countOf(result.lastWeek)).toBe(4);
  });

  it('uses the 28 days before this week, and the 28 before those, as the 4-week baseline', async () => {
    await seedWeeks();

    const [result] = await counterLogRepository.metricsByDate(WEEK_END, WEEK_START);

    expect(countOf(result.thisMonth)).toBe(8);
    expect(countOf(result.lastMonth)).toBe(2);
  });

  it('counts distinct users across the whole week', async () => {
    await seedWeeks();

    const [result] = await counterLogRepository.metricsByDate(WEEK_END, WEEK_START);

    expect(result.allUsers?.[0]?.count).toBe(2);
  });

  it('ranks top users by their interactions across the whole week', async () => {
    const { alice, bob } = await seedWeeks();

    const [result] = await counterLogRepository.metricsByDate(WEEK_END, WEEK_START);

    const interactionsByUser = Object.fromEntries(result.topUsers.map(user => [user._id, user.interactions]));
    expect(interactionsByUser).toEqual({ [alice]: 3, [bob]: 3 });
  });

  it('totals top organizations over the whole week', async () => {
    await seedWeeks();

    const [result] = await counterLogRepository.metricsByDate(WEEK_END, WEEK_START);

    expect(result.topOrganizations).toEqual([expect.objectContaining({ events: 6 })]);
  });

  it('takes the peak day from the whole week and last week', async () => {
    await seedWeeks();

    const [result] = await counterLogRepository.metricsByDate(WEEK_END, WEEK_START);

    expect(result.peakDay).toEqual({ date: '2026-06-03', totalEvents: 3 });
    expect(result.lastWeekPeakDay).toEqual({ date: '2026-05-27', totalEvents: 2 });
  });

  it('rejects a range whose end precedes its start', async () => {
    await expect(counterLogRepository.metricsByDate(WEEK_START, WEEK_END)).rejects.toThrow(
      'Invalid weekly report range'
    );
  });
});

describe('CounterLogRepository.metricsByDate - daily report window is unchanged', () => {
  it('counts only the UTC day and compares with the same day a week earlier', async () => {
    await seedWeeks();

    const [result] = await counterLogRepository.metricsByDate('2026-06-03');

    expect(countOf(result.thisWeek)).toBe(3);
    expect(countOf(result.lastWeek)).toBe(2);
    expect(result.thisMonth).toEqual([]);
    expect(result.lastMonth).toEqual([]);
  });
});

describe('CounterLogRepository.findAllWithUserByDateRange', () => {
  it('returns the logs of the UTC Monday-Sunday range', async () => {
    await seedWeeks();

    const logs = await counterLogRepository.findAllWithUserByDateRange(WEEK_START, WEEK_END);

    expect(logs).toHaveLength(6);
  });
});
