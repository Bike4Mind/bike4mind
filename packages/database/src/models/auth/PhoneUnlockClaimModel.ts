import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * `phoneHash` is an unsalted SHA-256 of the canonical E.164 number: it keeps the number out of plain
 * view, but the number space is small enough to enumerate, so treat the hash as personal data.
 * Claims are kept after account deletion on purpose (as `GithubUnlockClaim` is): dropping one would let
 * the number unlock again on a new account.
 */
export interface IPhoneUnlockClaimDocument extends IMongoDocument {
  phoneHash: string;
  userId: string;
  claimedAt: Date;
}

export type PhoneUnlockClaimResult = { claimed: boolean; owner: string };

const PhoneUnlockClaimSchema = new Schema<IPhoneUnlockClaimDocument>(
  {
    phoneHash: { type: String, required: true },
    userId: { type: String, required: true },
    claimedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true }
);

PhoneUnlockClaimSchema.index({ phoneHash: 1 }, { unique: true });

export interface IPhoneUnlockClaimModel extends Model<IPhoneUnlockClaimDocument> {}

export const PhoneUnlockClaim: IPhoneUnlockClaimModel =
  mongoose.models.PhoneUnlockClaim ?? model<IPhoneUnlockClaimDocument>('PhoneUnlockClaim', PhoneUnlockClaimSchema);

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

class PhoneUnlockClaimRepository extends BaseRepository<IPhoneUnlockClaimDocument> {
  async ownerOf(phoneHash: string): Promise<string | null> {
    const existing = await this.model.findOne({ phoneHash }).lean<IPhoneUnlockClaimDocument>();
    return existing?.userId ?? null;
  }

  async release(phoneHash: string, userId: string): Promise<void> {
    await this.model.deleteOne({ phoneHash, userId });
  }

  /** Claim a phone number for a user; a repeat by the same user succeeds, another user is refused. */
  async claim(phoneHash: string, userId: string): Promise<PhoneUnlockClaimResult> {
    // autoIndex builds lazily; the unique index must exist before the first insert or two can land.
    await this.model.init();
    try {
      await this.model.create({ phoneHash, userId, claimedAt: new Date() });
      return { claimed: true, owner: userId };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    const owner = await this.ownerOf(phoneHash);
    if (!owner) throw new Error('Phone unlock claim vanished after a duplicate-key error');
    return { claimed: owner === userId, owner };
  }
}

export const phoneUnlockClaimRepository = new PhoneUnlockClaimRepository(PhoneUnlockClaim);
