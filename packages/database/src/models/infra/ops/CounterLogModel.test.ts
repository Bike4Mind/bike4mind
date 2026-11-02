import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { dayjs } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { CounterLog, counterLogRepository } from './CounterLogModel';
import { CreditTransaction } from '../../billing/CreditTransactionModel';

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
  vi.restoreAllMocks();
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

const INTERNAL_FLAGS = ['isAdmin', 'isSystem', 'isSynthetic'] as const;

async function seedUser(
  email: string,
  createdAt?: Date,
  flags: Partial<Record<(typeof INTERNAL_FLAGS)[number], boolean>> = {}
) {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection
    .collection('users')
    .insertOne({ _id, email, ...(createdAt ? { createdAt } : {}), ...flags });
  return _id.toString();
}

const seedFlaggedUsers = () =>
  Promise.all(INTERNAL_FLAGS.map(flag => seedUser(`${flag}@example.com`, undefined, { [flag]: true })));

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

  it('counts admin, system and synthetic accounts as internal', async () => {
    const flagged = await seedFlaggedUsers();
    const external = await seedUser('customer@example.com');
    await CounterLog.insertMany([...flagged, external].map(id => logFor(id, inWindow)));

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(count(result.allUsers)).toBe(4);
    expect(count(result.internalUsers)).toBe(3);
  });

  it('still counts flagged accounts as internal when no staff domains are configured', async () => {
    delete process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
    const admin = await seedUser('admin@example.com', undefined, { isAdmin: true });
    await CounterLog.insertMany([logFor(admin, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

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

  it('excludes admin, system and synthetic accounts', async () => {
    const flagged = await seedFlaggedUsers();
    const external = await seedUser('customer@example.com');
    await CounterLog.insertMany([...flagged, external].map(id => logFor(id, threeDaysBefore)));

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

  it('rejects when the spend query fails instead of returning a ranking without credits', async () => {
    const userId = await seedUser('event-user@example.com');
    await CounterLog.insertMany([logFor(userId, inWindow)]);
    const aggregation = CreditTransaction.aggregate();
    vi.spyOn(aggregation, 'exec').mockRejectedValueOnce(new Error('ledger unavailable'));
    vi.spyOn(CreditTransaction, 'aggregate').mockReturnValueOnce(aggregation);

    await expect(counterLogRepository.metricsByDate(REPORT_DATE)).rejects.toThrow('ledger unavailable');
  });

  it('does not query the spend ledger for weekly reports', async () => {
    const aggregate = vi.spyOn(CreditTransaction, 'aggregate');

    await counterLogRepository.metricsByDate(REPORT_DATE, '2026-05-26');

    expect(aggregate).not.toHaveBeenCalled();
  });

  it('leaves out a spender with no counter events in the window', async () => {
    const apiOnly = await seedUser('api-only@example.com');
    await spendFor(apiOnly, 576);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(result.topUsers).toEqual([]);
  });

  it('ranks by event count rather than credits spent', async () => {
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

    expect(rankedIds(result.topUsers)).toEqual([busy, spender]);
    expect(result.topUsers?.map(user => user.interactions)).toEqual([3, 1]);
    expect(result.topUsers?.map(user => user.creditsSpent)).toEqual([10, 500]);
  });

  it('breaks an event tie by credits spent', async () => {
    // quieter is seeded first so its lower user id wins any id-based fallback; only the credits tie-break puts spender ahead
    const quieter = await seedUser('quieter@example.com');
    const spender = await seedUser('spender@example.com');
    await CounterLog.insertMany([logFor(quieter, inWindow), logFor(spender, inWindow)]);
    await spendFor(quieter, 1);
    await spendFor(spender, 100);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(rankedIds(result.topUsers)).toEqual([spender, quieter]);
  });

  it('applies the credits tie-break before cutting the list to twenty', async () => {
    const userIds = await Promise.all(Array.from({ length: 25 }, (_, index) => seedUser(`user${index}@example.com`)));
    await CounterLog.insertMany(userIds.map(userId => logFor(userId, inWindow)));
    // The highest id among equals would be cut by an id-only tie-break.
    const spender = [...userIds].sort().at(-1)!;
    await spendFor(spender, 10);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(rankedIds(result.topUsers)).toEqual([
      spender,
      ...userIds
        .filter(id => id !== spender)
        .sort()
        .slice(0, 19),
    ]);
  });

  it('counts only in-window AI usage owned by the user toward creditsSpent', async () => {
    const user = await seedUser('mixed@example.com');
    await CounterLog.insertMany([logFor(user, inWindow)]);
    await spendFor(user, 50);
    await spendFor(user, 900, new Date('2026-06-02T12:00:00.000Z'));
    await mongoose.connection.collection('credittransactions').insertMany([
      ...['generic_deduct', 'transfer_credit'].map(type => ({
        ownerId: user,
        ownerType: 'User',
        type,
        credits: -700,
        createdAt: inWindow,
      })),
      { ownerId: user, ownerType: 'Organization', type: 'text_generation_usage', credits: -1000, createdAt: inWindow },
    ]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(result.topUsers?.[0]).toEqual(expect.objectContaining({ creditsSpent: 50 }));
  });

  it('excludes staff-domain accounts even when they lead on both spend and events', async () => {
    const staff = await seedUser('teammate@staff.example.com');
    const external = await seedUser('customer@example.com');
    await CounterLog.insertMany([logFor(staff, inWindow), logFor(staff, inWindow), logFor(external, inWindow)]);
    await spendFor(staff, 1000);
    await spendFor(external, 1);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(rankedIds(result.topUsers)).toEqual([external]);
  });

  it('excludes admin, system and synthetic accounts', async () => {
    const flagged = await seedFlaggedUsers();
    const external = await seedUser('customer@example.com');
    await CounterLog.insertMany([
      ...flagged.flatMap(id => [logFor(id, inWindow), logFor(id, inWindow)]),
      logFor(external, inWindow),
    ]);

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

    expect(rankedIds(result.topUsers)).toEqual([stale, current]);
    expect(result.topUsers?.map(user => user.creditsSpent)).toEqual([0, 10]);
  });

  it('marks accounts created within 7 days of the window end as new', async () => {
    const recent = await seedUser('recent@example.com', sixDaysBefore);
    const veteran = await seedUser('veteran@example.com', eightDaysBefore);
    await CounterLog.insertMany([logFor(recent, inWindow), logFor(veteran, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    // Same events and spend, so the tie is broken by _id; assert by id rather than by order.
    const byId = Object.fromEntries((result.topUsers ?? []).map(user => [user._id, user.isNew]));
    expect(byId[recent]).toBe(true);
    expect(byId[veteran]).toBe(false);
  });

  it('bounds new-account tags against the historical window', async () => {
    const atCutoff = await seedUser('at-cutoff@example.com', new Date('2026-05-25T23:59:59.999Z'));
    const afterCutoff = await seedUser('after-cutoff@example.com', new Date('2026-05-26T00:00:00.000Z'));
    const future = await seedUser('future@example.com', new Date('2026-06-02T00:00:00.000Z'));
    const undated = await seedUser('undated@example.com');
    await CounterLog.insertMany([atCutoff, afterCutoff, future, undated].map(userId => logFor(userId, inWindow)));

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(Object.fromEntries((result.topUsers ?? []).map(user => [user._id, user.isNew]))).toEqual({
      [atCutoff]: false,
      [afterCutoff]: true,
      [future]: false,
      [undated]: false,
    });
  });
});

describe('findYoungAccountSpend', () => {
  const windowEnd = new Date('2026-06-01T12:00:00.000Z');
  const windowStart = new Date('2026-06-01T11:00:00.000Z');
  const halfHourAgo = new Date('2026-06-01T11:30:00.000Z');
  const twoHoursAgo = new Date('2026-06-01T10:00:00.000Z');

  it('totals hourly spend by accounts created in the last seven days and ranks the top spenders', async () => {
    const big = await seedUser('big@example.com', threeDaysBefore);
    const small = await seedUser('small@example.com', sixDaysBefore);
    const veteran = await seedUser('veteran@example.com', eightDaysBefore);
    const earlier = await seedUser('earlier@example.com', threeDaysBefore);
    await spendFor(big, 300, halfHourAgo);
    await spendFor(big, 200, halfHourAgo);
    await spendFor(small, 40, halfHourAgo);
    await spendFor(veteran, 9000, halfHourAgo);
    await spendFor(earlier, 700, twoHoursAgo);
    await mongoose.connection.collection('credittransactions').insertOne({
      ownerId: 'SYSTEM',
      ownerType: 'User',
      type: 'text_generation_usage',
      credits: -50,
      createdAt: halfHourAgo,
    });

    const result = await counterLogRepository.findYoungAccountSpend(windowStart, windowEnd, 1);

    expect(result.totalCredits).toBe(540);
    expect(result.accountCount).toBe(2);
    expect(result.topSpenders).toEqual([
      { userId: big, creditsSpent: 500, accountCreatedAt: threeDaysBefore, stripeCustomerId: null },
    ]);
  });

  it("carries each spender's Stripe customer id, or null when the account has none", async () => {
    const paying = await seedUser('paying@example.com', threeDaysBefore);
    const unpaid = await seedUser('unpaid@example.com', threeDaysBefore);
    await mongoose.connection
      .collection('users')
      .updateOne({ _id: new mongoose.Types.ObjectId(paying) }, { $set: { stripeCustomerId: 'cus_paying' } });
    await spendFor(paying, 300, halfHourAgo);
    await spendFor(unpaid, 200, halfHourAgo);

    const result = await counterLogRepository.findYoungAccountSpend(windowStart, windowEnd, 10);

    expect(result.topSpenders.map(({ userId, stripeCustomerId }) => ({ userId, stripeCustomerId }))).toEqual([
      { userId: paying, stripeCustomerId: 'cus_paying' },
      { userId: unpaid, stripeCustomerId: null },
    ]);
  });

  it('reads the hour through the ownerType/createdAt/type index instead of a collection scan', async () => {
    await CreditTransaction.init();
    await spendFor(await seedUser('plan@example.com', threeDaysBefore), 100, halfHourAgo);
    const aggregate = vi.spyOn(CreditTransaction, 'aggregate');
    await counterLogRepository.findYoungAccountSpend(windowStart, windowEnd, 10);
    const pipeline = aggregate.mock.calls[0][0] as mongoose.PipelineStage[];
    const explain = await CreditTransaction.collection.aggregate(pipeline).explain('queryPlanner');
    // Only the winning plan counts; a losing candidate can still name the index.
    const plan = JSON.stringify(explain, (key, value) => (key === 'rejectedPlans' ? undefined : value));
    expect(plan).toContain('ownerType_1_createdAt_-1_type_1');
    expect(plan).not.toContain('COLLSCAN');
  });

  it('excludes non-user owners and non-usage ledger entries', async () => {
    const userId = await seedUser('usage-only@example.com', threeDaysBefore);
    await spendFor(userId, 100, halfHourAgo);
    await mongoose.connection.collection('credittransactions').insertMany([
      {
        ownerId: userId,
        ownerType: 'Organization',
        type: 'text_generation_usage',
        credits: -9000,
        createdAt: halfHourAgo,
      },
      { ownerId: userId, ownerType: 'User', type: 'purchase', credits: 9000, createdAt: halfHourAgo },
    ]);
    const result = await counterLogRepository.findYoungAccountSpend(windowStart, windowEnd, 10);
    expect(result.totalCredits).toBe(100);
    expect(result.accountCount).toBe(1);
  });

  it('propagates aggregation failures instead of reporting zero spend', async () => {
    const error = new Error('ledger unavailable');
    vi.spyOn(CreditTransaction, 'aggregate').mockImplementationOnce(() => {
      throw error;
    });
    await expect(counterLogRepository.findYoungAccountSpend(windowStart, windowEnd, 10)).rejects.toBe(error);
  });

  it.each([
    ['exactly seven days old', new Date('2026-05-25T12:00:00.000Z'), 0],
    ['just under seven days old', new Date('2026-05-25T12:00:00.001Z'), 100],
    ['future creation date', new Date('2026-06-01T12:00:00.001Z'), 0],
    ['missing creation date', undefined, 0],
  ])('classifies an account with %s', async (_label, createdAt, expectedCredits) => {
    const userId = await seedUser('age-boundary@example.com', createdAt);
    await spendFor(userId, 100, halfHourAgo);
    const result = await counterLogRepository.findYoungAccountSpend(windowStart, windowEnd, 10);
    expect(result.totalCredits).toBe(expectedCredits);
    expect(result.accountCount).toBe(expectedCredits > 0 ? 1 : 0);
  });

  it('counts a boundary transaction only in the next adjacent window', async () => {
    const userId = await seedUser('boundary@example.com', threeDaysBefore);
    await spendFor(userId, 100, windowEnd);
    const first = await counterLogRepository.findYoungAccountSpend(windowStart, windowEnd, 10);
    const next = await counterLogRepository.findYoungAccountSpend(windowEnd, new Date('2026-06-01T13:00:00.000Z'), 10);
    expect(first.totalCredits).toBe(0);
    expect(next.totalCredits).toBe(100);
  });

  it('returns an empty summary when no young account spent', async () => {
    const veteran = await seedUser('veteran@example.com', eightDaysBefore);
    await spendFor(veteran, 100, halfHourAgo);

    expect(await counterLogRepository.findYoungAccountSpend(windowStart, windowEnd, 10)).toEqual({
      totalCredits: 0,
      accountCount: 0,
      topSpenders: [],
    });
  });
});
