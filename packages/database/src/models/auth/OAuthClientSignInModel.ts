import { IMongoDocument, IBaseRepository } from '@bike4mind/common';
import mongoose, { Schema, model, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * When an OAuth client first and last got a sign-in for a user: one row per (user, client), written
 * when an authorization code is redeemed for tokens. Unlike OAuthGrant it outlives a revoked consent, so it
 * answers which apps a person has signed in to, not which they may still sign in to.
 */
export interface IOAuthClientSignInDocument extends IMongoDocument {
  userId: string;
  clientId: string;
  firstSignInAt: Date;
  lastSignInAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IOAuthClientSignInRepository extends IBaseRepository<IOAuthClientSignInDocument> {
  /** Upsert the pair's row; out-of-order writes never move firstSignInAt later or lastSignInAt earlier. */
  recordSignIn(params: { userId: string; clientId: string; at: Date }): Promise<void>;
  /** This user's rows, most recent sign-in first. */
  listByUser(userId: string): Promise<IOAuthClientSignInDocument[]>;
  deleteAllForUser(userId: string): Promise<number>;
}

type IOAuthClientSignInModel = Model<IOAuthClientSignInDocument>;

const OAuthClientSignInSchema = new Schema<IOAuthClientSignInDocument>(
  {
    userId: { type: String, required: true },
    clientId: { type: String, required: true },
    firstSignInAt: { type: Date, required: true },
    lastSignInAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// One row per (client, user); the upsert keys on it, and the clientId prefix serves per-client counts.
OAuthClientSignInSchema.index({ clientId: 1, userId: 1 }, { unique: true });
OAuthClientSignInSchema.index({ userId: 1, lastSignInAt: -1 });

const isDuplicateKey = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

class OAuthClientSignInRepository
  extends BaseRepository<IOAuthClientSignInDocument>
  implements IOAuthClientSignInRepository
{
  constructor(m: IOAuthClientSignInModel) {
    super(m);
  }

  async recordSignIn({ userId, clientId, at }: { userId: string; clientId: string; at: Date }) {
    const upsert = () =>
      this.model
        .updateOne(
          { clientId, userId },
          { $min: { firstSignInAt: at }, $max: { lastSignInAt: at } },
          { upsert: true, runValidators: true }
        )
        .exec();
    try {
      await upsert();
    } catch (error: unknown) {
      // Two concurrent first sign-ins race the unique index; the loser's retry matches the winner's row.
      if (!isDuplicateKey(error)) throw error;
      await upsert();
    }
  }

  listByUser(userId: string) {
    return this.model.find({ userId }).sort({ lastSignInAt: -1 }).exec();
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.model.deleteMany({ userId });
    return result.deletedCount;
  }
}

export const OAuthClientSignInModel =
  (mongoose.models['OAuthClientSignIn'] as IOAuthClientSignInModel) ??
  model<IOAuthClientSignInDocument>('OAuthClientSignIn', OAuthClientSignInSchema);

export const oauthClientSignInRepository = new OAuthClientSignInRepository(OAuthClientSignInModel);
