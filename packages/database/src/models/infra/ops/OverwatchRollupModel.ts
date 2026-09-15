import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'OverwatchRollup';

/**
 * Precomputed DAU/WAU/MAU rollups, written by a daily cron job.
 * Dashboard reads from this collection for fast lookups.
 */
export interface IOverwatchRollupDoc {
  _id: string;
  productId: string;
  /** YYYY-MM-DD format */
  date: string;
  /** Daily active users (unique users on this date) */
  dau: number;
  /** Weekly active users (unique users in 7-day window ending on this date) */
  wau: number;
  /** Monthly active users (unique users in 30-day window ending on this date) */
  mau: number;
  createdAt: Date;
  updatedAt: Date;
}

interface IOverwatchRollupModel extends Model<IOverwatchRollupDoc> {}

const OverwatchRollupSchema = new Schema<IOverwatchRollupDoc>(
  {
    productId: { type: String, required: true },
    date: { type: String, required: true },
    dau: { type: Number, required: true, default: 0 },
    wau: { type: Number, required: true, default: 0 },
    mau: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

// One rollup per product per day. Unique constraint also serves latest-rollup queries via reverse scan.
OverwatchRollupSchema.index({ productId: 1, date: 1 }, { unique: true });

export const OverwatchRollup: IOverwatchRollupModel =
  (mongoose.models[ModelName] as IOverwatchRollupModel) ||
  model<IOverwatchRollupDoc, IOverwatchRollupModel>(ModelName, OverwatchRollupSchema);
