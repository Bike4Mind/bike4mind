import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IBlockedIPDocument extends IMongoDocument {
  ip: string;
  reason?: string;
  active: boolean;
  blockedAt: Date;
  expiresAt: Date;
  unblockedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const BlockedIPSchema = new mongoose.Schema<IBlockedIPDocument>(
  {
    ip: { type: String, required: true, index: true },
    reason: { type: String },
    active: { type: Boolean, default: true, index: true },
    blockedAt: { type: Date, default: () => new Date(), index: true },
    expiresAt: { type: Date, required: true, index: true },
    unblockedAt: { type: Date },
  },
  { timestamps: true }
);

BlockedIPSchema.index({ ip: 1, active: 1 }, { unique: false });

export const BlockedIP: Model<IBlockedIPDocument> =
  mongoose.models.BlockedIP || mongoose.model<IBlockedIPDocument>('BlockedIP', BlockedIPSchema);

export class BlockedIPRepository extends BaseRepository<IBlockedIPDocument> {
  constructor(model: Model<IBlockedIPDocument>) {
    super(model);
  }

  async block(ip: string, reason?: string): Promise<IBlockedIPDocument> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes from now

    // Check for existing active non-expired block
    const existing = await this.model.findOne({
      ip,
      active: true,
      expiresAt: { $gt: now },
    });
    if (existing) return existing;

    return this.model.create({
      ip,
      reason,
      active: true,
      blockedAt: now,
      expiresAt,
    });
  }

  async unblock(ip: string): Promise<IBlockedIPDocument | null> {
    return this.model.findOneAndUpdate({ ip, active: true }, { active: false, unblockedAt: new Date() }, { new: true });
  }

  async list(limit = 10): Promise<IBlockedIPDocument[]> {
    const now = new Date();
    return this.model
      .find({
        active: true,
        expiresAt: { $gt: now }, // Only show non-expired blocks
      })
      .sort({ blockedAt: -1 })
      .limit(limit);
  }

  async isBlocked(ip: string): Promise<IBlockedIPDocument | null> {
    const now = new Date();
    const blocked = await this.model.findOne({
      ip,
      active: true,
      expiresAt: { $gt: now }, // Block must not be expired
    });

    // Auto-unblock expired IPs
    if (!blocked) {
      await this.model.updateMany({ ip, active: true, expiresAt: { $lte: now } }, { active: false, unblockedAt: now });
    }

    return blocked;
  }
}

export const blockedIPRepository = new BlockedIPRepository(BlockedIP);
