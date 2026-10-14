import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { dayjs } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { CounterLog, counterLogRepository } from './CounterLogModel';

let mongod: MongoMemoryServer;
const originalStaffDomains = process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = 'staff.example.com';
});

afterAll(async () => {
  if (originalStaffDomains === undefined) {
    delete process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
  } else {
    process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = originalStaffDomains;
  }
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await CounterLog.deleteMany({});
  await mongoose.connection.collection('users').deleteMany({});
  process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = 'staff.example.com';
});

const REPORT_DATE = '2026-06-01';
const inWindow = new Date('2026-06-01T12:00:00.000Z');
const outOfWindow = new Date('2026-05-30T12:00:00.000Z');
const threeDaysBefore = new Date('2026-05-29T12:00:00.000Z');
const sixDaysBefore = new Date('2026-05-26T12:00:00.000Z');
const eightDaysBefore = new Date('2026-05-24T12:00:00.000Z');

async function seedUser(email: string) {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('users').insertOne({ _id, email });
  return _id.toString();
}

function logFor(userId: string, datetime: Date) {
  return {
    userId,
    userName: userId,
    userLevel: 'free',
    counterName: 'Model Started',
    counterValue: 1,
    datetime,
  };
}

const count = (facet?: Array<{ count: number }>) => facet?.[0]?.count ?? 0;

describe('CounterLogRepository.metricsByDate - daily distinct users (allUsers / internalUsers)', () => {
  it('counts more than 20 distinct users while topUsers stays capped at 20', async () => {
    const userIds = await Promise.all(Array.from({ length: 25 }, (_, i) => seedUser(`user${i}@example.com`)));
    await CounterLog.insertMany(userIds.map(id => logFor(id, inWindow)));

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.allUsers)).toBe(25);
    expect(count(result.internalUsers)).toBe(0);
    expect(result.topUsers).toHaveLength(20);
  });

  it('counts a user active multiple times in the window once', async () => {
    const userId = await seedUser('repeat@example.com');
    await CounterLog.insertMany([logFor(userId, inWindow), logFor(userId, inWindow), logFor(userId, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.allUsers)).toBe(1);
  });

  it('classifies a staff-domain user as internal so externals exclude them', async () => {
    const external = await seedUser('customer@example.com');
    const staff = await seedUser('teammate@staff.example.com');
    await CounterLog.insertMany([logFor(external, inWindow), logFor(staff, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.allUsers)).toBe(2);
    expect(count(result.internalUsers)).toBe(1);
  });

  it('treats everyone as external when no staff domains are configured', async () => {
    delete process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
    const external = await seedUser('customer@example.com');
    const staff = await seedUser('teammate@staff.example.com');
    await CounterLog.insertMany([logFor(external, inWindow), logFor(staff, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.allUsers)).toBe(2);
    expect(count(result.internalUsers)).toBe(0);
  });

  it('ignores activity outside the report window', async () => {
    const userId = await seedUser('old@example.com');
    await CounterLog.insertMany([logFor(userId, outOfWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.allUsers)).toBe(0);
  });

  it('still counts non-ObjectId userIds such as SYSTEM without aborting the aggregation', async () => {
    const userId = await seedUser('real@example.com');
    await CounterLog.insertMany([logFor(userId, inWindow), logFor('SYSTEM', inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.allUsers)).toBe(2);
  });

  it('uses a rolling 24h window for today: 23h ago counts, 25h ago does not', async () => {
    const recent = await seedUser('recent@example.com');
    const stale = await seedUser('stale@example.com');
    const now = dayjs();
    await CounterLog.insertMany([
      logFor(recent, now.subtract(23, 'hours').toDate()),
      logFor(stale, now.subtract(25, 'hours').toDate()),
    ]);

    const [result] = await counterLogRepository.metricsByDate(dayjs.utc().format('YYYY-MM-DD'));

    expect(count(result.allUsers)).toBe(1);
  });
});

describe('CounterLogRepository.metricsByDate - weeklyActiveUsers (real WAU)', () => {
  it('counts distinct users across the trailing 7 days, including ones not active in the daily window', async () => {
    const today = await seedUser('today@example.com');
    const earlier = await seedUser('earlier@example.com');
    await CounterLog.insertMany([logFor(today, inWindow), logFor(earlier, threeDaysBefore)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.weeklyActiveUsers)).toBe(2);
    expect(count(result.allUsers)).toBe(1);
  });

  it('includes activity 6 days back and excludes activity 8 days back', async () => {
    const inside = await seedUser('inside@example.com');
    const outside = await seedUser('outside@example.com');
    await CounterLog.insertMany([logFor(inside, sixDaysBefore), logFor(outside, eightDaysBefore)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.weeklyActiveUsers)).toBe(1);
  });

  it('counts a user active on several days once', async () => {
    const userId = await seedUser('regular@example.com');
    await CounterLog.insertMany([
      logFor(userId, inWindow),
      logFor(userId, threeDaysBefore),
      logFor(userId, sixDaysBefore),
    ]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.weeklyActiveUsers)).toBe(1);
  });

  it('excludes staff-domain users', async () => {
    const external = await seedUser('customer@example.com');
    const staff = await seedUser('teammate@staff.example.com');
    await CounterLog.insertMany([logFor(external, threeDaysBefore), logFor(staff, threeDaysBefore)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.weeklyActiveUsers)).toBe(1);
  });

  it('excludes nobody when no staff domains are configured', async () => {
    delete process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
    const external = await seedUser('customer@example.com');
    const teammate = await seedUser('teammate@staff.example.com');
    await CounterLog.insertMany([logFor(external, threeDaysBefore), logFor(teammate, threeDaysBefore)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.weeklyActiveUsers)).toBe(2);
  });

  it('counts a user whose user document no longer exists', async () => {
    const orphanId = new mongoose.Types.ObjectId().toString();
    await CounterLog.insertMany([logFor(orphanId, threeDaysBefore)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.weeklyActiveUsers)).toBe(1);
  });

  it('counts non-ObjectId userIds such as SYSTEM without aborting the aggregation', async () => {
    const userId = await seedUser('real@example.com');
    await CounterLog.insertMany([logFor(userId, threeDaysBefore), logFor('SYSTEM', threeDaysBefore)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.weeklyActiveUsers)).toBe(2);
  });

  it('is not computed for weekly reports, which never read it', async () => {
    const userId = await seedUser('weekly@example.com');
    await CounterLog.insertMany([logFor(userId, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE, '2026-05-26');

    expect(result.weeklyActiveUsers ?? []).toHaveLength(0);
  });
});
