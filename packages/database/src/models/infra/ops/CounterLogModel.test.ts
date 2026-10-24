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
  await mongoose.connection.collection('credittransactions').deleteMany({});
  process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = 'staff.example.com';
});

const REPORT_DATE = '2026-06-01';
const inWindow = new Date('2026-06-01T12:00:00.000Z');
const outOfWindow = new Date('2026-05-30T12:00:00.000Z');
const threeDaysBefore = new Date('2026-05-29T12:00:00.000Z');
const sixDaysBefore = new Date('2026-05-26T12:00:00.000Z');
const eightDaysBefore = new Date('2026-05-24T12:00:00.000Z');
// The weekly-active cutoff for REPORT_DATE (weekEnd - 7d) is 2026-05-25T23:59:59.999Z.
const justBeforeWauBound = new Date('2026-05-25T12:00:00.000Z');
const justAfterWauBound = new Date('2026-05-26T00:00:00.000Z');

async function seedUser(email: string, createdAt?: Date) {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('users').insertOne({ _id, email, ...(createdAt ? { createdAt } : {}) });
  return _id.toString();
}

/** Usage rows are stored negative; `credits` here is the magnitude the report should show. */
async function spendFor(userId: string, credits: number, createdAt: Date = inWindow) {
  await mongoose.connection.collection('credittransactions').insertOne({
    ownerId: userId,
    ownerType: 'User',
    type: 'text_generation_usage',
    credits: -credits,
    createdAt,
  });
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

  it('pins the 7-day lower bound: just before the cutoff is excluded, the day after is included', async () => {
    const beforeCutoff = await seedUser('before-cutoff@example.com');
    const afterCutoff = await seedUser('after-cutoff@example.com');
    await CounterLog.insertMany([logFor(beforeCutoff, justBeforeWauBound), logFor(afterCutoff, justAfterWauBound)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    // Exactly one of the two straddles the cutoff, so a widened or narrowed window fails this.
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

describe('CounterLogRepository.metricsByDate - topUsers email', () => {
  it.each([
    ['daily', undefined],
    ['weekly', '2026-05-26'],
  ])('takes the email from the user document in the %s report', async (_label, startDate) => {
    const userId = await seedUser('top@example.com');
    await CounterLog.insertMany([logFor(userId, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE, startDate);

    expect(result.topUsers).toEqual([expect.objectContaining({ _id: userId, email: 'top@example.com' })]);
  });

  it('returns a null email for a deleted user in the weekly report', async () => {
    const orphanId = new mongoose.Types.ObjectId().toString();
    await CounterLog.insertMany([logFor(orphanId, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE, '2026-05-26');

    expect(result.topUsers).toEqual([expect.objectContaining({ _id: orphanId, email: null })]);
  });

  it('drops a deleted user from the daily report, where the leaderboard is people only', async () => {
    const orphanId = new mongoose.Types.ObjectId().toString();
    await CounterLog.insertMany([logFor(orphanId, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(result.topUsers).toEqual([]);
  });
});

describe('CounterLogRepository.metricsByDate - daily topUsers leaderboard', () => {
  const rankedIds = (facet?: Array<{ _id: string }>) => (facet ?? []).map(u => u._id);

  it('ranks by credits spent rather than event count', async () => {
    const spender = await seedUser('spender@example.com');
    const busy = await seedUser('busy@example.com');
    await CounterLog.insertMany([
      logFor(spender, inWindow),
      logFor(busy, inWindow),
      logFor(busy, inWindow),
      logFor(busy, inWindow),
    ]);
    await spendFor(spender, 500);
    await spendFor(busy, 10);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(rankedIds(result.topUsers)).toEqual([spender, busy]);
    expect(result.topUsers?.[0]).toEqual(expect.objectContaining({ interactions: 1, creditsSpent: 500 }));
  });

  it('counts only in-window AI usage toward creditsSpent', async () => {
    const user = await seedUser('mixed@example.com');
    await CounterLog.insertMany([logFor(user, inWindow)]);
    await spendFor(user, 50);
    await spendFor(user, 900, new Date('2026-06-02T12:00:00.000Z'));
    await mongoose.connection.collection('credittransactions').insertMany(
      ['generic_deduct', 'transfer_credit'].map(type => ({
        ownerId: user,
        ownerType: 'User',
        type,
        credits: -700,
        createdAt: inWindow,
      }))
    );

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(result.topUsers?.[0]).toEqual(expect.objectContaining({ creditsSpent: 50 }));
  });

  it('breaks a spend tie by event count', async () => {
    const busier = await seedUser('busier@example.com');
    const quieter = await seedUser('quieter@example.com');
    await CounterLog.insertMany([logFor(quieter, inWindow), logFor(busier, inWindow), logFor(busier, inWindow)]);
    await spendFor(quieter, 100);
    await spendFor(busier, 100);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(rankedIds(result.topUsers)).toEqual([busier, quieter]);
  });

  it('excludes staff accounts even when they lead on both spend and events', async () => {
    const staff = await seedUser('teammate@staff.example.com');
    const external = await seedUser('customer@example.com');
    await CounterLog.insertMany([logFor(staff, inWindow), logFor(staff, inWindow), logFor(external, inWindow)]);
    await spendFor(staff, 1000);
    await spendFor(external, 1);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(rankedIds(result.topUsers)).toEqual([external]);
  });

  it('drops non-user ids such as SYSTEM from the leaderboard', async () => {
    const real = await seedUser('real@example.com');
    await CounterLog.insertMany([logFor('SYSTEM', inWindow), logFor('SYSTEM', inWindow), logFor(real, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(rankedIds(result.topUsers)).toEqual([real]);
  });

  it('only counts spend inside the report window', async () => {
    const current = await seedUser('current@example.com');
    const stale = await seedUser('stale@example.com');
    await CounterLog.insertMany([
      logFor(current, inWindow),
      logFor(stale, inWindow),
      logFor(stale, inWindow),
      logFor(stale, inWindow),
    ]);
    await spendFor(current, 10);
    await spendFor(stale, 1000, outOfWindow);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(rankedIds(result.topUsers)).toEqual([current, stale]);
    expect(result.topUsers?.[1]).toEqual(expect.objectContaining({ creditsSpent: 0 }));
  });

  it('marks accounts created within 7 days of the window end as new', async () => {
    const recent = await seedUser('recent@example.com', sixDaysBefore);
    const veteran = await seedUser('veteran@example.com', eightDaysBefore);
    await CounterLog.insertMany([logFor(recent, inWindow), logFor(veteran, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    // Same spend, so the tie is broken by _id; assert by id rather than by order.
    const byId = Object.fromEntries((result.topUsers ?? []).map(user => [user._id, user.isNew]));
    expect(byId[recent]).toBe(true);
    expect(byId[veteran]).toBe(false);
  });

  it('ranks a zero-spend user below every spender', async () => {
    const free = await seedUser('free@example.com');
    const spender = await seedUser('spender@example.com');
    await CounterLog.insertMany([logFor(free, inWindow), logFor(free, inWindow), logFor(spender, inWindow)]);
    await spendFor(spender, 1);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(rankedIds(result.topUsers)).toEqual([spender, free]);
    expect(result.topUsers?.[1]).toEqual(expect.objectContaining({ creditsSpent: 0 }));
  });
});
