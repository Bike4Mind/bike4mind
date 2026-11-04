import mongoose, { Document, Model, model, Schema } from 'mongoose';
import { USER_LIMIT_EVENT_KINDS, type UserLimitEventKind } from '@bike4mind/common';

/**
 * Limit hits and refusals for the admin user timeline (apps/client/server/utils/userTimelineLimits.ts).
 * Bounded by design: one row per user, kind, UTC hour and model, with a counter, so a client that
 * retries into a cap all day writes at most 24 rows per kind. Rows expire after 90 days and are
 * deleted with the account (purgeDeletedUserData).
 */
export interface IUserLimitEventDocument extends Document {
  id: string;
  userId: string;
  kind: UserLimitEventKind;
  /** Start of the UTC hour the hits fell in. */
  hour: Date;
  /** The refused or charged model; '' when the kind is not about one model. */
  modelId: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
  /** The latest hit's numbers (cap, spent, balance after, ...). Small and kind-specific. */
  details: Record<string, string | number | boolean | null>;
}

export type RecordUserLimitEventInput = {
  userId: string;
  kind: UserLimitEventKind;
  model?: string;
  details?: IUserLimitEventDocument['details'];
  at?: Date;
};

export const USER_LIMIT_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

const HOUR_MS = 60 * 60 * 1000;
const DUPLICATE_KEY = 11000;

const UserLimitEventSchema = new Schema<IUserLimitEventDocument>(
  {
    userId: { type: String, required: true },
    kind: { type: String, required: true, enum: USER_LIMIT_EVENT_KINDS },
    hour: { type: Date, required: true },
    modelId: { type: String, default: '' },
    count: { type: Number, required: true, min: 1 },
    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
    details: { type: Schema.Types.Mixed, default: {} },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true }, versionKey: false, minimize: false }
);

// The upsert key: concurrent hits in one hour race on it, and the loser retries as an update.
UserLimitEventSchema.index({ userId: 1, kind: 1, hour: 1, modelId: 1 }, { unique: true });
// The timeline's keyset read.
UserLimitEventSchema.index({ userId: 1, lastAt: -1, _id: -1 });
UserLimitEventSchema.index({ hour: 1 }, { expireAfterSeconds: USER_LIMIT_EVENT_RETENTION_SECONDS });

export const UserLimitEventModel: Model<IUserLimitEventDocument> =
  (mongoose.models.UserLimitEvent as unknown as Model<IUserLimitEventDocument>) ??
  model<IUserLimitEventDocument>('UserLimitEvent', UserLimitEventSchema);

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY;

export const userLimitEventRepository = {
  /** Counts one hit into its hour's row, creating the row on the first hit. */
  async record({ userId, kind, model: modelId = '', details = {}, at = new Date() }: RecordUserLimitEventInput) {
    const hour = new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
    const write = () =>
      UserLimitEventModel.updateOne(
        { userId, kind, hour, modelId },
        { $inc: { count: 1 }, $max: { lastAt: at }, $min: { firstAt: at }, $set: { details } },
        { upsert: true }
      );
    try {
      await write();
    } catch (error) {
      // Two first hits in the same hour: the other insert won, so this one is now a plain update.
      if (!isDuplicateKeyError(error)) throw error;
      await write();
    }
  },

  async deleteAllForUser(userId: string): Promise<number> {
    const { deletedCount } = await UserLimitEventModel.deleteMany({ userId });
    return deletedCount;
  },
};
