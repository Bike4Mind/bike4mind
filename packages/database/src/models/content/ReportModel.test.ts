import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { WEEKLY_REPORT_WINDOW_VERSION, WeeklyReport, weeklyReportRepository } from './ReportModel';

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

describe('WeeklyReportRepository window versioning', () => {
  it('does not serve a stored report written before the current window version', async () => {
    await WeeklyReport.collection.insertOne({ startDate: START, endDate: END, report: 'one-day report' });

    await expect(weeklyReportRepository.findByDateRange(START, END)).resolves.toBeFalsy();
  });

  it('overwrites the stale row on regeneration and serves the new one', async () => {
    await WeeklyReport.collection.insertOne({ startDate: START, endDate: END, report: 'one-day report' });

    await weeklyReportRepository.upsertReport(START, END, 'full-week report', null);

    const stored = await weeklyReportRepository.findByDateRange(START, END);
    expect(stored).toEqual(
      expect.objectContaining({ report: 'full-week report', windowVersion: WEEKLY_REPORT_WINDOW_VERSION })
    );
    await expect(WeeklyReport.countDocuments({ startDate: START, endDate: END })).resolves.toBe(1);
  });
});
