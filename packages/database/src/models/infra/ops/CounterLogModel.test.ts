import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
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
});

const REPORT_DATE = '2026-06-01';
const inWindow = new Date('2026-06-01T12:00:00.000Z');
const outOfWindow = new Date('2026-05-30T12:00:00.000Z');

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

describe('CounterLogRepository.metricsByDate - activeUsers (DAU)', () => {
  it('counts more than 20 distinct active users while topUsers stays capped at 20', async () => {
    const userIds = await Promise.all(Array.from({ length: 25 }, (_, i) => seedUser(`user${i}@example.com`)));
    await CounterLog.insertMany(userIds.map(id => logFor(id, inWindow)));

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(result.activeUsers?.[0]?.count).toBe(25);
    expect(result.topUsers).toHaveLength(20);
  });

  it('counts a user active multiple times in the window once', async () => {
    const userId = await seedUser('repeat@example.com');
    await CounterLog.insertMany([logFor(userId, inWindow), logFor(userId, inWindow), logFor(userId, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(result.activeUsers?.[0]?.count).toBe(1);
  });

  it('excludes staff matched by NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS', async () => {
    const external = await seedUser('customer@example.com');
    const staff = await seedUser('teammate@staff.example.com');
    await CounterLog.insertMany([logFor(external, inWindow), logFor(staff, inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(result.activeUsers?.[0]?.count).toBe(1);
  });

  it('ignores activity outside the report window', async () => {
    const userId = await seedUser('old@example.com');
    await CounterLog.insertMany([logFor(userId, outOfWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(result.activeUsers ?? []).toHaveLength(0);
  });

  it('still counts non-ObjectId userIds such as SYSTEM without aborting the aggregation', async () => {
    const userId = await seedUser('real@example.com');
    await CounterLog.insertMany([logFor(userId, inWindow), logFor('SYSTEM', inWindow)]);

    const [result] = await counterLogRepository.metricsByDate(REPORT_DATE);

    expect(result.activeUsers?.[0]?.count).toBe(2);
  });
});
