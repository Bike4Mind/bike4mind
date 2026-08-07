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
    nextHash: string,
    previousHash: string,
    graceExpiresAt: Date
  ): Promise<IAuthSessionDocument | null> {
    const now = new Date();
    // Atomic + scoped to a live session so a revoked/expired row is never resurrected by a rotate.
    return AuthSessionModel.findOneAndUpdate(
      { sid, revokedAt: null, expiresAt: { $gt: now } },
      {
        $set: {
          refreshTokenHash: nextHash,
          previousRefreshTokenHash: previousHash,
          graceExpiresAt,
          lastUsedAt: now,
        },
      },
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
