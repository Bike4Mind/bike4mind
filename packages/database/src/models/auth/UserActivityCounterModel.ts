import { IUserActivityCounter } from '@bike4mind/common';
import mongoose, { type Model, Schema } from 'mongoose';

/**
 * Per-user counter for how many times a user has performed a given action.
 * Only aggregate counts are stored; createdAt/updatedAt bound the first and
 * last occurrence (no per-event log).
 */
const UserActivityCounterSchema = new Schema<IUserActivityCounter>(
  {
    userId: { type: String, required: true },
    action: { type: String, required: true },
    count: { type: Number, default: 0 },
    tags: { type: [String], default: [] },
  },
  {
    virtuals: true,
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

UserActivityCounterSchema.index({ userId: 1, action: 1 }, { unique: true });

export const UserActivityCounter: Model<IUserActivityCounter> =
  mongoose.models.UserActivityCounter ||
  mongoose.model<IUserActivityCounter>('UserActivityCounter', UserActivityCounterSchema);
export default UserActivityCounter;
