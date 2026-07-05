import mongoose from 'mongoose';
import { IMarketingReportReadDocument, IMarketingReportReadRepository } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

interface IMarketingReportReadModel extends mongoose.Model<IMarketingReportReadDocument> {}

class MarketingReportReadRepository
  extends BaseRepository<IMarketingReportReadDocument>
  implements IMarketingReportReadRepository
{
  constructor(model: IMarketingReportReadModel) {
    super(model);
  }
}

const MarketingReportReadSchema = new mongoose.Schema<IMarketingReportReadDocument>(
  {
    userId: { type: String, required: true },
    reportId: { type: String, required: true },
    readAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true }
);

MarketingReportReadSchema.index({ userId: 1, reportId: 1 }, { unique: true });

export const MarketingReportRead: IMarketingReportReadModel =
  (mongoose.models.MarketingReportRead as IMarketingReportReadModel) ||
  mongoose.model<IMarketingReportReadDocument, IMarketingReportReadModel>(
    'MarketingReportRead',
    MarketingReportReadSchema
  );

export const marketingReportReadRepository = new MarketingReportReadRepository(MarketingReportRead);
