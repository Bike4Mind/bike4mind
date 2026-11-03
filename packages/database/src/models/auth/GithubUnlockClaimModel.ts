import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IGithubUnlockClaimDocument extends IMongoDocument {
  githubId: number;
  userId: string;
  claimedAt: Date;
}

export type GithubUnlockClaimResult = { claimed: boolean; owner: string };

const GithubUnlockClaimSchema = new Schema<IGithubUnlockClaimDocument>(
  {
    githubId: { type: Number, required: true },
    userId: { type: String, required: true },
    claimedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true }
);

GithubUnlockClaimSchema.index({ githubId: 1 }, { unique: true });

export interface IGithubUnlockClaimModel extends Model<IGithubUnlockClaimDocument> {}

export const GithubUnlockClaim: IGithubUnlockClaimModel =
  mongoose.models.GithubUnlockClaim ?? model<IGithubUnlockClaimDocument>('GithubUnlockClaim', GithubUnlockClaimSchema);

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

class GithubUnlockClaimRepository extends BaseRepository<IGithubUnlockClaimDocument> {
  async release(githubId: number, userId: string): Promise<void> {
    await this.model.deleteOne({ githubId, userId });
  }

  /** Claim a GitHub account for a user; a repeat by the same user succeeds, another user is refused. */
  async claim(githubId: number, userId: string): Promise<GithubUnlockClaimResult> {
    // autoIndex builds lazily; the unique index must exist before the first insert or two can land.
    await this.model.init();
    try {
      await this.model.create({ githubId, userId, claimedAt: new Date() });
      return { claimed: true, owner: userId };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    const existing = await this.model.findOne({ githubId }).lean<IGithubUnlockClaimDocument>();
    if (!existing) throw new Error('GitHub unlock claim vanished after a duplicate-key error');
    return { claimed: existing.userId === userId, owner: existing.userId };
  }
}

export const githubUnlockClaimRepository = new GithubUnlockClaimRepository(GithubUnlockClaim);
