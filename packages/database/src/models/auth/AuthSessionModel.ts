import { IAuthSessionDocument, IAuthSessionRepository, IAuthSessionStepUpEmailChallenge } from '@bike4mind/common';
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

const StepUpEmailChallengeSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
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
    recoveries: { type: Number, default: 0 },
    device: { type: AuthSessionDeviceSchema, default: undefined },
    createdVia: { type: String, required: true },
    impersonatedBy: { type: String, default: null },
    clientId: { type: String, default: null },
    lastUsedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    stepUpAt: { type: Date, default: null },
    stepUpPasswordFailures: { type: Number, default: 0 },
    stepUpEmailChallenge: { type: StepUpEmailChallengeSchema, default: null, select: false },
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
    params: { expectedCurrentHash: string; nextHash: string; replayExpiresAt: Date; newExpiresAt: Date }
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
          // Possession of the CURRENT secret is what proves a live client, so this is the only
          // write that clears the recovery allowance - see recoverRotateHash.
          recoveries: 0,
          // Sliding session window, computed by the caller (it holds createdAt for the cap).
          // Required here and absent from recoverRotateHash: only a true rotation earns a slide.
          expiresAt: params.newExpiresAt,
        },
      },
      { new: true }
    ).exec();
  }

  async recoverRotateHash(
    sid: string,
    params: { expectedPreviousHash: string; nextHash: string; replayExpiresAt: Date; maxRecoveries: number }
  ): Promise<IAuthSessionDocument | null> {
    const now = new Date();
    // Recovery CAS (see IAuthSessionRepository doc): an ELAPSED grace window is part of the filter,
    // so inside the window this never fires (coalesce handles that), and the winner re-opening
    // graceExpiresAt is what makes a racing second recovery lose. previous stays pinned to the
    // presented hash so siblings still holding it coalesce instead of forking - which is precisely
    // why the allowance below has to exist.
    //
    // `$lte: <Date>` is type-bracketed, so it matches an elapsed window but NOT a null/missing one:
    // a session that never rotated has no previous hash to recover from and is excluded by the
    // hash clause anyway (the two fields are only ever written together).
    //
    // `$not: { $gte }` rather than `$lt` on the allowance, for the same deploy-safety reason as
    // registerReplayUse: rows written before the field existed have it absent, and `$lt` silently
    // skips missing fields.
    return AuthSessionModel.findOneAndUpdate(
      {
        sid,
        previousRefreshTokenHash: params.expectedPreviousHash,
        graceExpiresAt: { $lte: now },
        recoveries: { $not: { $gte: params.maxRecoveries } },
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          refreshTokenHash: params.nextHash,
          graceExpiresAt: params.replayExpiresAt,
          lastUsedAt: now,
          replayUses: 0,
        },
        // Never reset here: only rotateHash (possession of the current secret) clears this.
        $inc: { recoveries: 1 },
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

  async markStepUp(sid: string, userId: string, at: Date): Promise<IAuthSessionDocument | null> {
    return AuthSessionModel.findOneAndUpdate(
      { sid, userId, revokedAt: null, expiresAt: { $gt: at } },
      { $set: { stepUpAt: at, stepUpPasswordFailures: 0 } },
      { new: true }
    ).exec();
  }

  async recordStepUpPasswordFailure(sid: string, userId: string): Promise<number | null> {
    const now = new Date();
    const session = await AuthSessionModel.findOneAndUpdate(
      { sid, userId, revokedAt: null, expiresAt: { $gt: now } },
      { $inc: { stepUpPasswordFailures: 1 } },
      { new: true }
    ).exec();
    return session ? (session.stepUpPasswordFailures ?? 0) : null;
  }

  async setStepUpEmailChallenge(
    sid: string,
    userId: string,
    challenge: Omit<IAuthSessionStepUpEmailChallenge, 'attempts'>
  ): Promise<boolean> {
    const result = await AuthSessionModel.updateOne(
      { sid, userId, revokedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { stepUpEmailChallenge: { ...challenge, attempts: 0 } } }
    ).exec();
    return result.matchedCount > 0;
  }

  async findStepUpEmailChallenge(sid: string, userId: string): Promise<IAuthSessionStepUpEmailChallenge | null> {
    const now = new Date();
    const session = await AuthSessionModel.findOne({
      sid,
      userId,
      revokedAt: null,
      expiresAt: { $gt: now },
      'stepUpEmailChallenge.expiresAt': { $gt: now },
    })
      .select('+stepUpEmailChallenge')
      .exec();
    return session?.stepUpEmailChallenge ?? null;
  }

  async recordStepUpEmailChallengeFailure(sid: string, tokenHash: string): Promise<number | null> {
    const session = await AuthSessionModel.findOneAndUpdate(
      { sid, revokedAt: null, 'stepUpEmailChallenge.tokenHash': tokenHash },
      { $inc: { 'stepUpEmailChallenge.attempts': 1 } },
      { new: true }
    )
      .select('+stepUpEmailChallenge')
      .exec();
    return session?.stepUpEmailChallenge?.attempts ?? null;
  }

  async consumeStepUpEmailChallenge(
    sid: string,
    userId: string,
    tokenHash: string,
    at: Date,
    maxAttempts: number
  ): Promise<IAuthSessionDocument | null> {
    // The tokenHash in the filter is the compare-and-swap: of N concurrent correct submissions,
    // only the first clears the challenge, so one code yields one step-up. The attempts and expiry
    // terms re-check at write time what the caller read earlier, closing the gap between the two.
    return AuthSessionModel.findOneAndUpdate(
      {
        sid,
        userId,
        revokedAt: null,
        expiresAt: { $gt: at },
        'stepUpEmailChallenge.tokenHash': tokenHash,
        'stepUpEmailChallenge.attempts': { $lt: maxAttempts },
        'stepUpEmailChallenge.expiresAt': { $gt: at },
      },
      { $set: { stepUpAt: at, stepUpEmailChallenge: null } },
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
