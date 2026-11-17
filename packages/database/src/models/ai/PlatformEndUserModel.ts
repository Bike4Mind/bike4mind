import mongoose, { Model, Schema } from 'mongoose';

const ModelName = 'PlatformEndUser';
const DUPLICATE_KEY = 11000;

// ms. lastSeenAt is refreshed at most this often, so a busy end user costs one write an hour, not one per request.
export const PLATFORM_END_USER_SEEN_REFRESH_MS = 60 * 60 * 1000;

/**
 * One row per end user a platform API key (`ai:end-user-id`) has named with `end_user_id`, keyed by
 * the identifier the model provider received (toPlatformEndUserProviderId). It is what lets
 * GET /api/admin/users/by-provider-id resolve a provider notice about such an end user back to the
 * platform account.
 */
export interface IPlatformEndUser {
  providerEndUserId: string;
  /** The user who owns the platform key. */
  keyOwnerId: string;
  /** The key most recently seen sending this end user. */
  apiKeyId?: string;
  /** The platform's own `end_user_id`, as sent. */
  endUserId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface IPlatformEndUserDocument extends IPlatformEndUser, mongoose.Document {}

const PlatformEndUserSchema = new Schema<IPlatformEndUserDocument>(
  {
    providerEndUserId: { type: String, required: true, unique: true },
    keyOwnerId: { type: String, required: true },
    apiKeyId: { type: String },
    endUserId: { type: String, required: true },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { versionKey: false }
);

// The owner's end users, newest first; also what an account purge deletes by.
PlatformEndUserSchema.index({ keyOwnerId: 1, lastSeenAt: -1 });

export const PlatformEndUser: Model<IPlatformEndUserDocument> =
  (mongoose.models[ModelName] as Model<IPlatformEndUserDocument>) ||
  mongoose.model<IPlatformEndUserDocument>(ModelName, PlatformEndUserSchema);

export interface RecordPlatformEndUserInput {
  providerEndUserId: string;
  keyOwnerId: string;
  apiKeyId?: string;
  endUserId: string;
}

export const platformEndUserRepository = {
  /**
   * Upsert the row for an end user seen now. Matches only a row whose lastSeenAt is stale, so a
   * fresh row turns the upsert into a duplicate-key insert, which is the cheap "nothing to do".
   */
  async recordSeen(input: RecordPlatformEndUserInput, now = new Date()): Promise<void> {
    const staleBefore = new Date(now.getTime() - PLATFORM_END_USER_SEEN_REFRESH_MS);
    try {
      await PlatformEndUser.updateOne(
        { providerEndUserId: input.providerEndUserId, lastSeenAt: { $lt: staleBefore } },
        {
          $setOnInsert: { keyOwnerId: input.keyOwnerId, endUserId: input.endUserId, firstSeenAt: now },
          $set: { lastSeenAt: now, ...(input.apiKeyId && { apiKeyId: input.apiKeyId }) },
        },
        { upsert: true }
      );
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) return;
      throw error;
    }
  },

  async findByProviderEndUserId(providerEndUserId: string): Promise<IPlatformEndUser | null> {
    return PlatformEndUser.findOne({ providerEndUserId }).lean<IPlatformEndUser>();
  },
};
