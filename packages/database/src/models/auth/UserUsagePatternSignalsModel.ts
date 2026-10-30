import {
  type IUserUsagePatternSignals,
  USAGE_PATTERN_SIGNAL_IDS,
  USAGE_PATTERN_SKIP_REASONS,
  type UsagePatternSignalsResult,
  type UsagePatternSkipReason,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import mongoose, { type Model, Schema } from 'mongoose';

/** A result not refreshed for this long (the account went quiet) is dropped. */
export const USAGE_PATTERN_SIGNALS_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const SignalSchema = new Schema(
  {
    id: { type: String, required: true, enum: USAGE_PATTERN_SIGNAL_IDS },
    value: { type: Number, default: null },
    triggered: { type: Boolean, required: true },
    weight: { type: Number, required: true },
    explanation: { type: String, required: true },
  },
  { _id: false, id: false }
);

const UserUsagePatternSignalsSchema = new Schema<IUserUsagePatternSignals>(
  {
    userId: { type: String, required: true, unique: true },
    signals: { type: [SignalSchema], default: [] },
    score: { type: Number, required: true },
    needsReview: { type: Boolean, required: true },
    computedAt: { type: Date, required: true },
    skipped: { type: String, enum: USAGE_PATTERN_SKIP_REASONS },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

UserUsagePatternSignalsSchema.index({ needsReview: 1, score: -1 });
UserUsagePatternSignalsSchema.index({ computedAt: 1 }, { expireAfterSeconds: USAGE_PATTERN_SIGNALS_RETENTION_SECONDS });

export const UserUsagePatternSignals: Model<IUserUsagePatternSignals> =
  (mongoose.models.UserUsagePatternSignals as Model<IUserUsagePatternSignals>) ??
  mongoose.model<IUserUsagePatternSignals>('UserUsagePatternSignals', UserUsagePatternSignalsSchema);

export class UserUsagePatternSignalsRepository extends BaseRepository<IUserUsagePatternSignals> {
  constructor(model: Model<IUserUsagePatternSignals>) {
    super(model);
  }

  /** Replaces the user's previous result, so the collection holds one document per user. */
  async upsertLatest(userId: string, result: UsagePatternSignalsResult, computedAt: Date): Promise<void> {
    await this.model.updateOne(
      { userId },
      {
        $set: { signals: result.signals, score: result.score, needsReview: result.needsReview, computedAt },
        $unset: { skipped: 1 },
      },
      { upsert: true }
    );
  }

  /** Records a checked-but-unscored user so it rotates behind never-checked users on the next run. */
  async markSkipped(userId: string, reason: UsagePatternSkipReason, computedAt: Date): Promise<void> {
    await this.model.updateOne(
      { userId },
      { $set: { signals: [], score: 0, needsReview: false, skipped: reason, computedAt } },
      { upsert: true }
    );
  }

  async findByUserId(userId: string): Promise<IUserUsagePatternSignals | null> {
    return this.model.findOne({ userId }).exec();
  }
}

export const userUsagePatternSignalsRepository = new UserUsagePatternSignalsRepository(UserUsagePatternSignals);
