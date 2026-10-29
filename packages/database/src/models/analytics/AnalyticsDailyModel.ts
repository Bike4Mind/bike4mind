import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type { IMongoDocument } from '@bike4mind/common';
import { ANALYTICS_DAY_PATTERN } from './AnalyticsUserDayModel';

export interface IAnalyticsDailySignups {
  legit: number;
  suspected: number;
  unclassified: number;
  bySignal: Record<string, number>;
}

/** One row per UTC day: platform-wide activity and signup totals derived from analytics_user_days. */
export interface IAnalyticsDaily {
  day: string; // YYYY-MM-DD (UTC)
  signups: IAnalyticsDailySignups;
  dau: number;
  wau: number;
  mau: number;
  requestsByFeature: Record<string, number>;
  requestsBySource: Record<string, number>;
  requestsByModel: Record<string, number>;
  creditsConsumed: number;
  computedAt: Date;
}

export type IAnalyticsDailyDocument = IAnalyticsDaily & IMongoDocument;

// Same payload guard as the usage-event model breakdown: bounds the stored map.
export const ANALYTICS_BY_MODEL_LIMIT = 100;

const AnalyticsDailySchema = new Schema<IAnalyticsDailyDocument>(
  {
    day: { type: String, required: true, match: ANALYTICS_DAY_PATTERN },
    signups: {
      type: new Schema(
        {
          legit: { type: Number, required: true, default: 0 },
          suspected: { type: Number, required: true, default: 0 },
          unclassified: { type: Number, required: true, default: 0 },
          bySignal: { type: Schema.Types.Mixed, default: {} },
        },
        { _id: false }
      ),
      required: true,
      default: () => ({ legit: 0, suspected: 0, unclassified: 0, bySignal: {} }),
    },
    dau: { type: Number, required: true, default: 0 },
    wau: { type: Number, required: true, default: 0 },
    mau: { type: Number, required: true, default: 0 },
    requestsByFeature: { type: Schema.Types.Mixed, default: {} },
    requestsBySource: { type: Schema.Types.Mixed, default: {} },
    requestsByModel: { type: Schema.Types.Mixed, default: {} },
    creditsConsumed: { type: Number, required: true, default: 0 },
    computedAt: { type: Date, required: true },
  },
  { timestamps: true, minimize: false }
);

AnalyticsDailySchema.index({ day: 1 }, { unique: true });

export type IAnalyticsDailyModel = Model<IAnalyticsDailyDocument>;

export class AnalyticsDailyRepository extends BaseRepository<IAnalyticsDailyDocument> {
  constructor(model: IAnalyticsDailyModel) {
    super(model);
  }

  async upsertDay(day: string, data: Omit<IAnalyticsDaily, 'day'>): Promise<void> {
    await this.model.updateOne({ day }, { $set: { ...data, day } }, { upsert: true });
  }
}

export const AnalyticsDaily =
  (mongoose.models['AnalyticsDaily'] as unknown as IAnalyticsDailyModel) ??
  model<IAnalyticsDailyDocument>('AnalyticsDaily', AnalyticsDailySchema);
export const analyticsDailyRepository = new AnalyticsDailyRepository(AnalyticsDaily);
