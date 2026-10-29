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
  source: 'auto' | 'manual';
  /** 0 for manual blocks; for auto blocks, the step reached in the escalation schedule. */
  escalationLevel: number;
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
    source: { type: String, enum: ['auto', 'manual'], default: 'manual' },
    escalationLevel: { type: Number, default: 0 },
  },
  { timestamps: true }
);

BlockedIPSchema.index({ ip: 1, active: 1 }, { unique: false });
BlockedIPSchema.index({ ip: 1, blockedAt: -1 });

export const DEFAULT_BLOCK_DURATION_MS = 10 * 60 * 1000;

export interface BlockOptions {
  durationMs?: number;
  source?: 'auto' | 'manual';
  escalationLevel?: number;
}

export const BlockedIP: Model<IBlockedIPDocument> =
  mongoose.models.BlockedIP || mongoose.model<IBlockedIPDocument>('BlockedIP', BlockedIPSchema);

export class BlockedIPRepository extends BaseRepository<IBlockedIPDocument> {
  constructor(model: Model<IBlockedIPDocument>) {
    super(model);
  }

  async block(
    ip: string,
    reason?: string,
    options: BlockOptions = {}
  ): Promise<{ doc: IBlockedIPDocument; created: boolean }> {
    const { durationMs = DEFAULT_BLOCK_DURATION_MS, source = 'manual', escalationLevel = 0 } = options;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMs);

    const existing = await this.isBlocked(ip);
    if (existing) {
      // Repeat blocks only ever extend the window (a short manual block must not cut an escalated
      // auto block), without a new row or audit entry.
      const refreshed = await this.model.findOneAndUpdate(
        { ip, active: true, expiresAt: { $lt: expiresAt } },
        { expiresAt },
        { new: true }
      );
      return { doc: refreshed ?? existing, created: false };
    }

    const doc = await this.model.create({
      ip,
      reason,
      active: true,
      blockedAt: now,
      expiresAt,
      source,
      escalationLevel,
    });
    return { doc, created: true };
  }

  /** The most recent block of this IP, active or not. */
  async findLatestBlock(ip: string): Promise<IBlockedIPDocument | null> {
    return this.model.findOne({ ip }).sort({ blockedAt: -1 });
  }

  async unblock(ip: string): Promise<IBlockedIPDocument | null> {
    const update = { active: false, unblockedAt: new Date() };
    const doc = await this.model.findOneAndUpdate({ ip, active: true }, update, { new: true, sort: { blockedAt: -1 } });
    // Concurrent block() calls can leave more than one active row, and isBlocked() matches any of them.
    if (doc) await this.model.updateMany({ ip, active: true }, update);
    return doc;
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
