import {
  ipAddressKey,
  parseIpRange,
  type IMongoDocument,
  type IpBlockScope,
  type IpBlockSurface,
} from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IBlockedIPDocument extends IMongoDocument {
  /** A bare address, or a CIDR range in canonical form (see parseIpRange). */
  ip: string;
  /** First and last address as comparable hex (ipAddressKey); absent on rows written before ranges. */
  rangeStart?: string;
  rangeEnd?: string;
  /** Absent on rows written before scopes, which were all login lockouts. */
  scope?: IpBlockScope;
  reason?: string;
  blockedById?: string;
  blockedByName?: string;
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
    rangeStart: { type: String },
    rangeEnd: { type: String },
    scope: { type: String, enum: ['login', 'all'], default: 'login' },
    reason: { type: String },
    blockedById: { type: String },
    blockedByName: { type: String },
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
  /** Ignored when `expiresAt` is given. */
  durationMs?: number;
  expiresAt?: Date;
  source?: 'auto' | 'manual';
  escalationLevel?: number;
  scope?: IpBlockScope;
  blockedBy?: { id: string; name?: string };
}

/** Rows that apply on this surface: a login route honours every block, any other only `all` blocks. */
const scopeFilter = (surface: IpBlockSurface) => (surface === 'login' ? {} : { scope: 'all' });

/** The stored `ip` values a caller's address or range may have: its canonical form and, for rows written before canonicalization, the raw text. */
const ipValues = (target: string) => {
  const canonical = parseIpRange(target)?.canonical;
  return canonical && canonical !== target ? { $in: [canonical, target] } : target;
};

/** Range fields for a block target; a target parseIpRange rejects is stored as an exact-match row. */
const rangeFields = (target: string) => {
  const range = parseIpRange(target);
  return range ? { ip: range.canonical, rangeStart: range.start, rangeEnd: range.end } : { ip: target };
};

export const BlockedIP: Model<IBlockedIPDocument> =
  mongoose.models.BlockedIP || mongoose.model<IBlockedIPDocument>('BlockedIP', BlockedIPSchema);

export class BlockedIPRepository extends BaseRepository<IBlockedIPDocument> {
  constructor(model: Model<IBlockedIPDocument>) {
    super(model);
  }

  async block(
    target: string,
    reason?: string,
    options: BlockOptions = {}
  ): Promise<{ doc: IBlockedIPDocument; created: boolean; extended: boolean }> {
    const { durationMs = DEFAULT_BLOCK_DURATION_MS, source = 'manual', escalationLevel = 0, scope = 'login' } = options;
    const now = new Date();
    const expiresAt = options.expiresAt ?? new Date(now.getTime() + durationMs);
    const fields = rangeFields(target);

    // Only a block of the same target that already covers the requested scope is reused: an `all`
    // request over a login lockout gets its own row, since the lockout must not widen silently.
    const existing = await this.model
      .findOne({
        ip: fields.ip,
        active: true,
        expiresAt: { $gt: now },
        ...(scope === 'all' ? { scope: 'all' } : {}),
      })
      .sort({ blockedAt: -1 });
    if (existing) {
      // Repeat blocks only ever extend the window (a short manual block must not cut an escalated
      // auto block), without a new row.
      const refreshed = await this.model.findOneAndUpdate(
        { _id: existing._id, active: true, expiresAt: { $gt: now, $lt: expiresAt } },
        { expiresAt },
        { new: true }
      );
      return { doc: refreshed ?? existing, created: false, extended: refreshed !== null };
    }

    const doc = await this.model.create({
      ...fields,
      scope,
      reason,
      active: true,
      blockedAt: now,
      expiresAt,
      source,
      escalationLevel,
      blockedById: options.blockedBy?.id,
      blockedByName: options.blockedBy?.name,
    });
    return { doc, created: true, extended: false };
  }

  /** The most recent block of this IP, active or not. */
  async findLatestBlock(ip: string): Promise<IBlockedIPDocument | null> {
    return this.model.findOne({ ip: ipValues(ip) }).sort({ blockedAt: -1 });
  }

  async unblock(ip: string): Promise<IBlockedIPDocument | null> {
    const update = { active: false, unblockedAt: new Date() };
    const match = { ip: ipValues(ip), active: true };
    const doc = await this.model.findOneAndUpdate(match, update, { new: true, sort: { blockedAt: -1 } });
    // Concurrent block() calls can leave more than one active row, and isBlocked() matches any of them.
    if (doc) await this.model.updateMany(match, update);
    return doc;
  }

  async unblockById(id: string): Promise<IBlockedIPDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    return this.model.findOneAndUpdate(
      { _id: id, active: true },
      { active: false, unblockedAt: new Date() },
      { new: true }
    );
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

  /**
   * Every unexpired `all` block, for callers that match in memory instead of querying per request.
   * Capped as a safety valve; a list this long means blocks should be ranges instead.
   */
  async listActiveAllScope(cap = 5000): Promise<IBlockedIPDocument[]> {
    return this.model
      .find({ active: true, scope: 'all', expiresAt: { $gt: new Date() } })
      .sort({ blockedAt: -1 })
      .limit(cap);
  }

  /**
   * The active block that refuses this address on this surface: an exact-match row, or a range row
   * containing it. Legacy rows without range fields match on the exact address only.
   */
  async isBlocked(ip: string, surface: IpBlockSurface = 'login'): Promise<IBlockedIPDocument | null> {
    const now = new Date();
    const key = ipAddressKey(ip);
    const exact = ipValues(ip);
    const blocked = await this.model.findOne({
      active: true,
      expiresAt: { $gt: now }, // Block must not be expired
      ...scopeFilter(surface),
      $or: [{ ip: exact }, ...(key ? [{ rangeStart: { $lte: key }, rangeEnd: { $gte: key } }] : [])],
    });

    // Auto-unblock expired IPs
    if (!blocked) {
      await this.model.updateMany(
        { ip: exact, active: true, expiresAt: { $lte: now } },
        { active: false, unblockedAt: now }
      );
    }

    return blocked;
  }
}

export const blockedIPRepository = new BlockedIPRepository(BlockedIP);
