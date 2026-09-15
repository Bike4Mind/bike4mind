import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'OverwatchUserFirstSeen';

/**
 * Permanent first-seen record per (productId, userId).
 * Kept separate from OverwatchUserDay to survive the 180-day TTL on that collection.
 * Used by the cohort aggregation to classify users as "new" (first seen within
 * the trailing 7 days) vs "older" (first seen earlier).
 *
 * firstSeenDate for users active before deploy is approximated to the oldest
 * surviving OverwatchUserDay record (data beyond the 180-day TTL is unrecoverable).
 */
export interface IOverwatchUserFirstSeenDoc {
  _id: string;
  productId: string;
  userId: string;
  /** YYYY-MM-DD format */
  firstSeenDate: string;
  createdAt: Date;
}

interface IOverwatchUserFirstSeenModel extends Model<IOverwatchUserFirstSeenDoc> {}

const OverwatchUserFirstSeenSchema = new Schema<IOverwatchUserFirstSeenDoc>(
  {
    productId: { type: String, required: true },
    userId: { type: String, required: true },
    firstSeenDate: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One record per user per product; unique compound index
OverwatchUserFirstSeenSchema.index({ productId: 1, userId: 1 }, { unique: true });
// Supports cohort aggregation bucketing queries
OverwatchUserFirstSeenSchema.index({ productId: 1, firstSeenDate: 1 });

export const OverwatchUserFirstSeen: IOverwatchUserFirstSeenModel =
  (mongoose.models[ModelName] as IOverwatchUserFirstSeenModel) ||
  model<IOverwatchUserFirstSeenDoc, IOverwatchUserFirstSeenModel>(ModelName, OverwatchUserFirstSeenSchema);
