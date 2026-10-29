import { IMongoDocument } from './common';

/**
 * Format/metrics version of the persisted activity reports (DailyReport and WeeklyReport rows).
 * Bump it whenever the report text or metrics change: a stored row whose version is missing or
 * lower is treated as absent and regenerated, so past reports pick up the fix.
 * Version 2: weekly reports count the full startDate..endDate week (CounterLogModel.ts
 * `weeklyReportWindows`); earlier weekly rows covered only the last day.
 */
export const ACTIVITY_REPORT_VERSION = 2;

export interface IWeeklyReport {
  startDate: string;
  endDate: string;
  report: string;
  aiInsights?: string | null;
  reportVersion?: number;
}

export interface IDailyReport {
  date: string;
  report: string;
  aiInsights?: string | null;
  reportVersion?: number;
}

export interface IWeeklyReportDocument extends IWeeklyReport, IMongoDocument {
  createdAt: Date;
  updatedAt: Date;
}

export interface IDailyReportDocument extends IDailyReport, IMongoDocument {
  createdAt: Date;
  updatedAt: Date;
}

export interface IWeeklyReportRepository {
  findByDateRange(startDate: string, endDate: string): Promise<IWeeklyReportDocument | null>;
  upsertReport(
    startDate: string,
    endDate: string,
    report: string,
    aiInsights?: string | null
  ): Promise<IWeeklyReportDocument>;
}

export interface IDailyReportRepository {
  findByDate(date: string): Promise<IDailyReportDocument | null>;
  upsertReport(date: string, report: string, aiInsights?: string | null): Promise<IDailyReportDocument>;
}
