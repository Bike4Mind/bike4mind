import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type { IMongoDocument } from '@bike4mind/common';

export const ANALYTICS_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A user's usage billed to one organization on one day. */
export interface IAnalyticsUserDayOrg {
  orgId: string;
  requests: number;
  creditsCharged: number;
  /** First-party activity billed to this org; absent on older rollups. */
  active?: boolean;
}

/** One row per (UTC day, user) with activity; the source for DAU/WAU/MAU and per-user rollups. */
export interface IAnalyticsUserDay {
  day: string; // YYYY-MM-DD (UTC)
  userId: string;
  ownerType: 'User' | 'Organization' | 'Agent';
  /** The org the user used most that day. */
  orgId?: string;
  /** Every org the user used that day, with only that org's share. Absent on rows rolled up before it existed. */
  orgs?: IAnalyticsUserDayOrg[];
  requests: number;
  creditsCharged: number;
  features: string[];
  sources: string[];
  signupDay?: string; // YYYY-MM-DD (UTC) of the user's account creation
  suspected: boolean;
  /** At least one first-party request that day (see ACTIVE_SOURCES); the DAU/WAU/MAU rows. */
  active: boolean;
}

export type IAnalyticsUserDayDocument = IAnalyticsUserDay & IMongoDocument;

const AnalyticsUserDaySchema = new Schema<IAnalyticsUserDayDocument>(
  {
    day: { type: String, required: true, match: ANALYTICS_DAY_PATTERN },
    userId: { type: String, required: true },
    ownerType: { type: String, required: true, enum: ['User', 'Organization', 'Agent'] },
    orgId: { type: String, required: false },
    orgs: {
      type: [
        new Schema<IAnalyticsUserDayOrg>(
          {
            orgId: { type: String, required: true },
            requests: { type: Number, required: true },
            creditsCharged: { type: Number, required: true },
            active: { type: Boolean, required: false },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    requests: { type: Number, required: true, default: 0 },
    creditsCharged: { type: Number, required: true, default: 0 },
    features: { type: [String], default: [] },
    sources: { type: [String], default: [] },
    signupDay: { type: String, required: false, match: ANALYTICS_DAY_PATTERN },
    suspected: { type: Boolean, required: true, default: false },
    active: { type: Boolean, required: true, default: false },
  },
  { timestamps: true, collection: 'analytics_user_days' }
);

AnalyticsUserDaySchema.index({ day: 1, userId: 1 }, { unique: true });
AnalyticsUserDaySchema.index({ userId: 1, day: 1 });
AnalyticsUserDaySchema.index({ signupDay: 1, day: 1 });
AnalyticsUserDaySchema.index({ day: 1, active: 1, userId: 1 });

export type IAnalyticsUserDayModel = Model<IAnalyticsUserDayDocument>;

export class AnalyticsUserDayRepository extends BaseRepository<IAnalyticsUserDayDocument> {
  constructor(model: IAnalyticsUserDayModel) {
    super(model);
  }

  /** Ids of the users with a row in the inclusive [fromDay, toDay] range that also matches `filter`. */
  async distinctUserIds(
    fromDay: string,
    toDay: string,
    filter: { active: true } | { sources: string } = { active: true }
  ): Promise<string[]> {
    return this.model.distinct('userId', { day: { $gte: fromDay, $lte: toDay }, ...filter }).maxTimeMS(60_000);
  }
}

export const AnalyticsUserDay =
  (mongoose.models['AnalyticsUserDay'] as unknown as IAnalyticsUserDayModel) ??
  model<IAnalyticsUserDayDocument>('AnalyticsUserDay', AnalyticsUserDaySchema);
export const analyticsUserDayRepository = new AnalyticsUserDayRepository(AnalyticsUserDay);
