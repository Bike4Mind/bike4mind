import mongoose, { Model, Schema, model } from 'mongoose';
import { type OverwatchUserType } from '@bike4mind/common';

const ModelName = 'OverwatchUserDay';

/**
 * One document per unique (productId, date, userId) combination.
 * DAU = countDocuments({ productId, date }).
 * Scales to millions of DAU without BSON document size limits.
 */
export interface IOverwatchUserDayDoc {
  _id: string;
  productId: string;
  /** YYYY-MM-DD format */
  date: string;
  userId: string;
  /** Last observed user type for the day. Allowlist: subscriber | free | trial. */
  userType?: OverwatchUserType;
  createdAt: Date;
}

interface IOverwatchUserDayModel extends Model<IOverwatchUserDayDoc> {}

const OverwatchUserDaySchema = new Schema<IOverwatchUserDayDoc>(
  {
    productId: { type: String, required: true },
    date: { type: String, required: true },
    userId: { type: String, required: true },
    userType: { type: String },
  },
  { timestamps: true }
);

// Compound unique index: one doc per user per day per product.
// Left-prefix { productId, date } satisfies DAU countDocuments - no separate index needed.
OverwatchUserDaySchema.index({ productId: 1, date: 1, userId: 1 }, { unique: true });
// TTL: retain user-day records for 180 days
OverwatchUserDaySchema.index({ createdAt: 1 }, { expireAfterSeconds: 15552000 });

export const OverwatchUserDay: IOverwatchUserDayModel =
  (mongoose.models[ModelName] as IOverwatchUserDayModel) ||
  model<IOverwatchUserDayDoc, IOverwatchUserDayModel>(ModelName, OverwatchUserDaySchema);
