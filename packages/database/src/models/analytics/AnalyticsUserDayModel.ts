import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type { IMongoDocument } from '@bike4mind/common';

export const ANALYTICS_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** One row per (UTC day, user) with activity; the source for DAU/WAU/MAU and per-user rollups. */
export interface IAnalyticsUserDay {
  day: string; // YYYY-MM-DD (UTC)
  userId: string;
  ownerType: 'User' | 'Organization' | 'Agent';
  orgId?: string;
  requests: number;
  creditsCharged: number;
  features: string[];
  sources: string[];
  signupDay?: string; // YYYY-MM-DD (UTC) of the user's account creation
  suspected: boolean;
}

export type IAnalyticsUserDayDocument = IAnalyticsUserDay & IMongoDocument;

const AnalyticsUserDaySchema = new Schema<IAnalyticsUserDayDocument>(
  {
    day: { type: String, required: true, match: ANALYTICS_DAY_PATTERN },
    userId: { type: String, required: true },
    ownerType: { type: String, required: true, enum: ['User', 'Organization', 'Agent'] },
    orgId: { type: String, required: false },
    requests: { type: Number, required: true, default: 0 },
    creditsCharged: { type: Number, required: true, default: 0 },
    features: { type: [String], default: [] },
    sources: { type: [String], default: [] },
    signupDay: { type: String, required: false, match: ANALYTICS_DAY_PATTERN },
    suspected: { type: Boolean, required: true, default: false },
  },
  { timestamps: true, collection: 'analytics_user_days' }
);

AnalyticsUserDaySchema.index({ day: 1, userId: 1 }, { unique: true });
AnalyticsUserDaySchema.index({ userId: 1, day: 1 });
AnalyticsUserDaySchema.index({ signupDay: 1, day: 1 });

export type IAnalyticsUserDayModel = Model<IAnalyticsUserDayDocument>;

export class AnalyticsUserDayRepository extends BaseRepository<IAnalyticsUserDayDocument> {
  constructor(model: IAnalyticsUserDayModel) {
    super(model);
  }

  /** Distinct users active in the inclusive [fromDay, toDay] range. */
  async countDistinctUsers(fromDay: string, toDay: string): Promise<number> {
    const rows = await this.model.distinct('userId', { day: { $gte: fromDay, $lte: toDay } }).maxTimeMS(60_000);
    return rows.length;
  }
}

export const AnalyticsUserDay =
  (mongoose.models['AnalyticsUserDay'] as unknown as IAnalyticsUserDayModel) ??
  model<IAnalyticsUserDayDocument>('AnalyticsUserDay', AnalyticsUserDaySchema);
export const analyticsUserDayRepository = new AnalyticsUserDayRepository(AnalyticsUserDay);
