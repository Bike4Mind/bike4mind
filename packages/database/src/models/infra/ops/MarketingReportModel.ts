import mongoose from 'mongoose';
import { softDeletePlugin } from '../../../utils/mongo';
import { IMarketingReportDocument, IMarketingReportRepository, MarketingReportStatus } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

interface IMarketingReportModel extends mongoose.Model<IMarketingReportDocument> {}

class MarketingReportRepository extends BaseRepository<IMarketingReportDocument> implements IMarketingReportRepository {
  constructor(model: IMarketingReportModel) {
    super(model);
  }
}

const MarketingReportSchema = new mongoose.Schema<IMarketingReportDocument>(
  {
    title: { type: String, required: true, maxlength: 200 },
    subtitle: { type: String, maxlength: 300 },
    reportDate: { type: Date, required: true },
    markdownContent: { type: String, required: true },
    htmlContent: { type: String, required: true },
    tags: [{ type: String }],
    createdByUserId: { type: String, required: true },
    createdByName: { type: String, required: true },
    createdByApiKeyId: { type: String },
    createdByKeyName: { type: String },
    organizationId: { type: String },
    status: {
      type: String,
      enum: ['draft', 'published'] satisfies MarketingReportStatus[],
      default: 'draft',
      required: true,
    },
    publishedAt: { type: Date },
    lastRepublishedAt: { type: Date },
    version: { type: Number, default: 1, required: true },
  },
  { timestamps: true }
);

MarketingReportSchema.plugin(softDeletePlugin);

MarketingReportSchema.index({ deletedAt: 1, status: 1, createdAt: -1 });
MarketingReportSchema.index({ deletedAt: 1, reportDate: -1 });

export const MarketingReport: IMarketingReportModel =
  (mongoose.models.MarketingReport as IMarketingReportModel) ||
  mongoose.model<IMarketingReportDocument, IMarketingReportModel>('MarketingReport', MarketingReportSchema);

export const marketingReportRepository = new MarketingReportRepository(MarketingReport);
