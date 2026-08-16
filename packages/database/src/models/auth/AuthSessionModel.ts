import { IAuthSessionDocument, IAuthSessionRepository } from '@bike4mind/common';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

const AuthSessionDeviceSchema = new Schema(
  {
    userAgent: { type: String },
    browser: { type: String },
    os: { type: String },
    ip: { type: String },
    location: { type: String },
  },
  { _id: false }
);

const AuthSessionSchema = new Schema<IAuthSessionDocument>(
  {
    sid: { type: String, required: true, unique: true }, // unique: data constraint
    userId: { type: String, required: true },
    refreshTokenHash: { type: String, required: true },
    previousRefreshTokenHash: { type: String, default: null },
    graceExpiresAt: { type: Date, default: null },
    replayUses: { type: Number, default: 0 },
    device: { type: AuthSessionDeviceSchema, default: undefined },
    createdVia: { type: String, required: true },
    impersonatedBy: { type: String, default: null },
    lastUsedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Performance/lifecycle indexes (declared together; sid uniqueness is on the field above).
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL: drop expired sessions
AuthSessionSchema.index({ userId: 1, revokedAt: 1 }); // active-sessions lookups

export type IAuthSessionModel = Model<IAuthSessionDocument>;

export const AuthSessionModel =
  (mongoose.models['AuthSession'] as unknown as IAuthSessionModel) ??
  model<IAuthSessionDocument>('AuthSession', AuthSessionSchema);

class AuthSessionRepository extends BaseRepository<IAuthSessionDocument> implements IAuthSessionRepository {
  constructor(model: IAuthSessionModel) {
    super(model);
  }

  async findBySid(sid: string): Promise<IAuthSessionDocument | null> {
    return this.findOne({ sid });
  }

  async findActiveByUserId(userId: string): Promise<IAuthSessionDocument[]> {
    return AuthSessionModel.find({
      userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ lastUsedAt: -1 })
      .exec();
  }

  async rotateHash(
    sid: string,
    params: { expectedCurrentHash: string; nextHash: string; replayExpiresAt: Date }
  ): Promise<IAuthSessionDocument | null> {
    const now = new Date();
    // `refreshTokenHash` in the FILTER is the compare-and-swap: it makes this a conditional write
    // that only the first of N concurrent rotations can win. Scoped to a live session too, so a
    // revoked/expired row is never resurrected by a rotate.
    return AuthSessionModel.findOneAndUpdate(
      { sid, refreshTokenHash: params.expectedCurrentHash, revokedAt: null, expiresAt: { $gt: now } },
      {
        $set: {
          refreshTokenHash: params.nextHash,
          previousRefreshTokenHash: params.expectedCurrentHash,
          graceExpiresAt: params.replayExpiresAt,
          lastUsedAt: now,
          // A fresh generation gets a fresh allowance; see registerReplayUse.
          replayUses: 0,
        },
      },
      { new: true }
    ).exec();
  }

  async registerReplayUse(sid: string, maxUses: number): Promise<IAuthSessionDocument | null> {
    const now = new Date();
    // Atomic claim on one unit of the superseded secret's replay allowance. Without a cap the
    // window is purely time-based, so a single stale secret could be presented over and over for
    // its full duration, minting a fresh access token every time - bounded only by the endpoint's
    // per-IP rate limit. The counter makes the real blast radius "N access tokens", not "as many
    // as fit in the window".
    //
    // `$not: { $gte }` rather than `$lt` so rows written before this field existed (where it is
    // absent, not 0) still match - a `$lt` filter silently skips missing fields and would reject
    // every in-flight session on deploy.
    return AuthSessionModel.findOneAndUpdate(
      {
        sid,
        revokedAt: null,
        expiresAt: { $gt: now },
        replayUses: { $not: { $gte: maxUses } },
      },
      { $inc: { replayUses: 1 }, $set: { lastUsedAt: now } },
      { new: true }
    ).exec();
  }

  async revokeBySid(sid: string): Promise<IAuthSessionDocument | null> {
    return AuthSessionModel.findOneAndUpdate(
      { sid, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { new: true }
    ).exec();
  }

  async revokeAllByUserId(userId: string, options?: { exceptSid?: string }): Promise<number> {
    const filter: Record<string, unknown> = { userId, revokedAt: null };
    if (options?.exceptSid) filter.sid = { $ne: options.exceptSid };
    const result = await AuthSessionModel.updateMany(filter, { $set: { revokedAt: new Date() } }).exec();
    return result.modifiedCount ?? 0;
  }
}

export const authSessionRepository = new AuthSessionRepository(AuthSessionModel);
