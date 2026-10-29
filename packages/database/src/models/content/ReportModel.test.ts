import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { ACTIVITY_REPORT_VERSION } from '@bike4mind/common';
import { WeeklyReport, weeklyReportRepository } from './ReportModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await WeeklyReport.deleteMany({});
});

const START = '2026-06-01';
const END = '2026-06-07';

describe('WeeklyReportRepository report versioning', () => {
  it('overwrites a row written before the full-week window with the current version', async () => {
    await WeeklyReport.collection.insertOne({ startDate: START, endDate: END, report: 'one-day report' });

    await weeklyReportRepository.upsertReport(START, END, 'full-week report', null);

    const stored = await weeklyReportRepository.findByDateRange(START, END);
    expect(stored).toEqual(
      expect.objectContaining({ report: 'full-week report', reportVersion: ACTIVITY_REPORT_VERSION })
    );
    await expect(WeeklyReport.countDocuments({ startDate: START, endDate: END })).resolves.toBe(1);
  });
});
