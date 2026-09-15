import { IMongoDocument } from './common';

export interface IWeeklyReport {
  startDate: string;
  endDate: string;
  report: string;
  aiInsights?: string | null;
}

export interface IDailyReport {
  date: string;
  report: string;
  aiInsights?: string | null;
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
