import mongoose, { Schema, type Model, type Types } from 'mongoose';
import { CAMPAIGN_WATCH_MAX_MEMBERS, type CampaignWatch } from '@bike4mind/common';

export type CampaignWatchDocument = Omit<CampaignWatch, 'id'> & {
  _id: Types.ObjectId;
  cohortKey: string;
};

const schema = new Schema<CampaignWatchDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    userIds: { type: [String], required: true, validate: (ids: string[]) => ids.length <= CAMPAIGN_WATCH_MAX_MEMBERS },
    cohortKey: { type: String, required: true },
    sourceDetectionId: { type: String, default: null },
    ownerId: { type: String, default: null },
    status: { type: String, enum: ['open', 'closed'], default: 'open', required: true },
    revision: { type: Number, required: true, default: 0 },
    closedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'campaignwatches' }
);

schema.index({ status: 1, _id: -1 });
schema.index({ userIds: 1 });
schema.index({ ownerId: 1 });
schema.index({ cohortKey: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });

export const CampaignWatchModel: Model<CampaignWatchDocument> =
  (mongoose.models.CampaignWatch as Model<CampaignWatchDocument>) ??
  mongoose.model<CampaignWatchDocument>('CampaignWatch', schema);

export const campaignWatchRepository = {
  async removeUser(userId: string): Promise<void> {
    await CampaignWatchModel.updateMany({ userIds: userId }, { $pull: { userIds: userId }, $inc: { revision: 1 } });
    await CampaignWatchModel.updateMany({ ownerId: userId }, { $set: { ownerId: null }, $inc: { revision: 1 } });
  },
};
