import mongoose, { Schema, Types, type Document, type Model } from 'mongoose';

export const PUSH_TOKEN_KINDS = ['device', 'liveActivity'] as const;
export type PushTokenKind = (typeof PUSH_TOKEN_KINDS)[number];

/** Open for future platforms; widen the tuple, not the schema. */
export const PUSH_TOKEN_PLATFORMS = ['ios'] as const;
export type PushTokenPlatform = (typeof PUSH_TOKEN_PLATFORMS)[number];

export const PUSH_TOKEN_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type PushTokenEnvironment = (typeof PUSH_TOKEN_ENVIRONMENTS)[number];

/**
 * A push-delivery token registered by a first-party client, bound to the auth session (`sid`) that
 * registered it so that ending the session (logout, revoke, admin revoke) ends its pushes. The
 * pruning lives in AuthSessionRepository's revoke methods; see revokeBySid and revokeAllByUserId there.
 * Sessions that expire are deleted by AuthSession's TTL index without a revoke; their tokens are
 * pruned at delivery instead (deliverPush in apps/workers/src/events/sendPush.ts).
 *
 * `token` is globally unique: a physical device token belongs to one account at a time, so
 * re-registering it under another user (shared device, account switch) moves ownership.
 */
export type IPushToken = {
  userId: Types.ObjectId;
  sid: string;
  kind: PushTokenKind;
  platform: PushTokenPlatform;
  environment: PushTokenEnvironment;
  token: string;
  /** Live Activity tokens only. */
  activityId?: string;
  questId?: string;
  appVersion?: string;
  lastSeenAt: Date;
};

export type IPushTokenDocument = IPushToken & Document & { id: string; createdAt: Date; updatedAt: Date };

export type PushTokenUpsertInput = Omit<IPushToken, 'lastSeenAt' | 'userId'> & { userId: string };

const pushTokenSchema = new Schema<IPushTokenDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sid: { type: String, required: true },
    kind: { type: String, enum: PUSH_TOKEN_KINDS, required: true },
    platform: { type: String, enum: PUSH_TOKEN_PLATFORMS, required: true },
    environment: { type: String, enum: PUSH_TOKEN_ENVIRONMENTS, required: true },
    token: { type: String, required: true, unique: true }, // unique: data constraint
    activityId: { type: String },
    questId: { type: String },
    appVersion: { type: String },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

pushTokenSchema.index({ userId: 1, kind: 1 });
pushTokenSchema.index({ sid: 1 });

const modelName = 'PushToken';

export const PushTokenModel: Model<IPushTokenDocument> =
  (mongoose.models[modelName] as Model<IPushTokenDocument> | undefined) ??
  mongoose.model<IPushTokenDocument>(modelName, pushTokenSchema, 'pushtokens');

export class PushTokenRepository {
  /**
   * Idempotent register keyed on `token`. Re-registering refreshes owner, session, metadata and
   * lastSeenAt, so the same device token moves to whoever last authenticated with it. Optional
   * fields absent from the input are cleared rather than left stale from a previous owner.
   */
  async upsert(input: PushTokenUpsertInput): Promise<IPushTokenDocument> {
    const { token, activityId, questId, appVersion, ...rest } = input;
    const set = { ...rest, userId: new Types.ObjectId(input.userId), lastSeenAt: new Date() };
    const unset = {
      ...(activityId === undefined && { activityId: '' }),
      ...(questId === undefined && { questId: '' }),
      ...(appVersion === undefined && { appVersion: '' }),
    };
    return PushTokenModel.findOneAndUpdate(
      { token },
      {
        $set: {
          ...set,
          ...(activityId !== undefined && { activityId }),
          ...(questId !== undefined && { questId }),
          ...(appVersion !== undefined && { appVersion }),
        },
        ...(Object.keys(unset).length > 0 && { $unset: unset }),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).exec();
  }

  /**
   * Returns whether a row was removed; an unknown token is not an error. Pass `userId` to remove only
   * a token that user owns (the API route does, so one account cannot unregister another's device).
   * Pass `sid` to remove the row only while it is still bound to the session it was read under: push
   * delivery prunes with the read-time sid, so a token re-registered under a new session meanwhile
   * keeps its row (the same race removeBySids guards).
   */
  async removeByToken(token: string, options?: { userId?: string; sid?: string }): Promise<boolean> {
    if (options?.userId !== undefined && !mongoose.isObjectIdOrHexString(options.userId)) return false;
    const result = await PushTokenModel.deleteOne({
      token,
      ...(options?.userId !== undefined && { userId: new Types.ObjectId(options.userId) }),
      ...(options?.sid !== undefined && { sid: options.sid }),
    }).exec();
    return result.deletedCount > 0;
  }

  async removeBySid(sid: string): Promise<number> {
    const result = await PushTokenModel.deleteMany({ sid }).exec();
    return result.deletedCount;
  }

  /**
   * Keyed on sid, not token: a token re-registered under a new session after it was read keeps its row.
   * Push delivery uses this for sessions the AuthSession TTL index deleted without a revoke.
   */
  async removeBySids(sids: readonly string[]): Promise<number> {
    if (sids.length === 0) return 0;
    const result = await PushTokenModel.deleteMany({ sid: { $in: [...sids] } }).exec();
    return result.deletedCount;
  }

  /** Every token for a user except those bound to `exceptSid` ("revoke my other devices"). */
  async removeByUser(userId: string, options?: { exceptSid?: string }): Promise<number> {
    // AuthSession.userId is a free-form string; one that is not an ObjectId cannot own a token.
    if (!mongoose.isObjectIdOrHexString(userId)) return 0;
    const result = await PushTokenModel.deleteMany({
      userId: new Types.ObjectId(userId),
      ...(options?.exceptSid && { sid: { $ne: options.exceptSid } }),
    }).exec();
    return result.deletedCount;
  }

  async findByUser(userId: string, kind: PushTokenKind): Promise<IPushTokenDocument[]> {
    return PushTokenModel.find({ userId: new Types.ObjectId(userId), kind }).exec();
  }

  /** The live activity tokens registered for one quest; scoped to the owner so a quest id alone reaches no one. */
  async findLiveActivityByQuest(userId: string, questId: string): Promise<IPushTokenDocument[]> {
    if (!mongoose.isObjectIdOrHexString(userId)) return [];
    return PushTokenModel.find({ userId: new Types.ObjectId(userId), kind: 'liveActivity', questId }).exec();
  }

  /** Drops a finished quest's live activity tokens; returns how many rows were removed. */
  async removeLiveActivityByQuest(userId: string, questId: string): Promise<number> {
    if (!mongoose.isObjectIdOrHexString(userId)) return 0;
    const result = await PushTokenModel.deleteMany({
      userId: new Types.ObjectId(userId),
      kind: 'liveActivity',
      questId,
    }).exec();
    return result.deletedCount;
  }
}

export const pushTokenRepository = new PushTokenRepository();
