import mongoose, { Model, Schema, model } from 'mongoose';
import { OVERWATCH_LANE_VALUES, type OverwatchLane, type OverwatchUserType } from '@bike4mind/common';

const ModelName = 'OverwatchUserDay';

/** Name of the partial `{ productId, date }` index over rows marked `lane: 'synthetic'`. */
export const OVERWATCH_USER_DAY_SYNTHETIC_LANE_INDEX = 'productId_1_date_1_lane_synthetic';

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
  /**
   * 'synthetic' when any of the user's events that day carried that lane. Sticky: written only
   * with that value and never cleared. Absent means unmarked, which is every row written before
   * the lane existed and every user no event marked - never a verified real user.
   */
  lane?: OverwatchLane;
  createdAt: Date;
}

interface IOverwatchUserDayModel extends Model<IOverwatchUserDayDoc> {}

const OverwatchUserDaySchema = new Schema<IOverwatchUserDayDoc>(
  {
    productId: { type: String, required: true },
    date: { type: String, required: true },
    userId: { type: String, required: true },
    userType: { type: String },
    // No default: an old row must keep reading as unmarked, and nothing writes a value on its behalf.
    lane: { type: String, enum: OVERWATCH_LANE_VALUES },
  },
  { timestamps: true }
);

// Compound unique index: one doc per user per day per product.
// Left-prefix { productId, date } satisfies DAU countDocuments - no separate index needed.
OverwatchUserDaySchema.index({ productId: 1, date: 1, userId: 1 }, { unique: true });
// Synthetic-lane reads match `{ productId (or $in), date (range or $in), lane: 'synthetic' }`. On the
// unique index they fetch every user-day in range to test `lane`; this partial index holds only the
// marked rows. A read without that equality (DAU, `lane: { $ne }`) cannot use it. Named so it cannot
// clash with an unfiltered `productId_1_date_1`. Pre-built by migration 20260921235978.
OverwatchUserDaySchema.index(
  { productId: 1, date: 1 },
  { name: OVERWATCH_USER_DAY_SYNTHETIC_LANE_INDEX, partialFilterExpression: { lane: 'synthetic' } }
);
// TTL: retain user-day records for 180 days
OverwatchUserDaySchema.index({ createdAt: 1 }, { expireAfterSeconds: 15552000 });

export const OverwatchUserDay: IOverwatchUserDayModel =
  (mongoose.models[ModelName] as IOverwatchUserDayModel) ||
  model<IOverwatchUserDayDoc, IOverwatchUserDayModel>(ModelName, OverwatchUserDaySchema);
