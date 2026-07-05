import { IBaseRepository, IMongoDocument } from '.';

export type MarketingReportStatus = 'draft' | 'published';

export interface IMarketingReport {
  title: string;
  subtitle?: string;
  reportDate: Date;
  markdownContent: string;
  htmlContent: string;
  tags?: string[];
  createdByUserId: string;
  createdByName: string;
  createdByApiKeyId?: string;
  createdByKeyName?: string;
  organizationId?: string;
  status: MarketingReportStatus;
  publishedAt?: Date;
  lastRepublishedAt?: Date;
  version: number;
  deletedAt?: Date;
}

export interface IMarketingReportDocument extends IMarketingReport, IMongoDocument {}

export interface IMarketingReportRepository extends IBaseRepository<IMarketingReportDocument> {}

export interface IMarketingReportRead {
  userId: string;
  reportId: string;
  readAt: Date;
}

export interface IMarketingReportReadDocument extends IMarketingReportRead, IMongoDocument {}

export interface IMarketingReportReadRepository extends IBaseRepository<IMarketingReportReadDocument> {}
