import mongoose from 'mongoose';
import {
  IDailyReportDocument,
  IWeeklyReportDocument,
  IDailyReportRepository,
  IWeeklyReportRepository,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

// Daily Report
class DailyReportRepository extends BaseRepository<IDailyReportDocument> implements IDailyReportRepository {
  constructor(model: mongoose.Model<IDailyReportDocument>) {
    super(model);
  }

  async findByDate(date: string) {
    return this.findOne({ date });
  }

  async upsertReport(date: string, report: string, aiInsights?: string | null) {
    return this.model.findOneAndUpdate(
      { date },
      { date, report, aiInsights, updatedAt: new Date() },
      { upsert: true, new: true }
    );
  }
}

const DailyReportSchema = new mongoose.Schema<IDailyReportDocument>(
  {
    date: { type: String, required: true, unique: true },
    report: { type: String, required: true },
    aiInsights: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// Weekly Report
class WeeklyReportRepository extends BaseRepository<IWeeklyReportDocument> implements IWeeklyReportRepository {
  constructor(model: mongoose.Model<IWeeklyReportDocument>) {
    super(model);
  }

  async findByDateRange(startDate: string, endDate: string) {
    return this.findOne({ startDate, endDate });
  }

  async upsertReport(startDate: string, endDate: string, report: string, aiInsights?: string | null) {
    return this.model.findOneAndUpdate(
      { startDate, endDate },
      { startDate, endDate, report, aiInsights, updatedAt: new Date() },
      { upsert: true, new: true }
    );
  }
}

const WeeklyReportSchema = new mongoose.Schema<IWeeklyReportDocument>(
  {
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    report: { type: String, required: true },
    aiInsights: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// Compound index to ensure uniqueness of startDate and endDate combination
WeeklyReportSchema.index({ startDate: 1, endDate: 1 }, { unique: true });

export const DailyReport =
  mongoose.models.DailyReport || mongoose.model<IDailyReportDocument>('DailyReport', DailyReportSchema);
export const WeeklyReport =
  mongoose.models.WeeklyReport || mongoose.model<IWeeklyReportDocument>('WeeklyReport', WeeklyReportSchema);

export const dailyReportRepository = new DailyReportRepository(DailyReport);
export const weeklyReportRepository = new WeeklyReportRepository(WeeklyReport);
