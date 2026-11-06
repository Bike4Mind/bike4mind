import mongoose, { Document, Model, model, Schema } from 'mongoose';
import { isIP } from 'node:net';
import BaseRepository from '@bike4mind/db-core';
import type { INetworkMeta } from '@bike4mind/common';
import { NETWORK_META_FIELDS } from './networkMetaFields';

export const AUTH_EVENT_TYPES = ['signup', 'login'] as const;
export type AuthEventType = (typeof AUTH_EVENT_TYPES)[number];

/**
 * One successful signup or login with the network it came from (apps/client
 * server/auth/networkMeta.ts). Raw IPs are PII, so rows expire after AUTH_EVENT_RETENTION_SECONDS
 * and are deleted with the account (purgeDeletedUserData).
 */
export interface IAuthEventDocument extends Document, INetworkMeta {
  id: string;
  userId: string;
  type: AuthEventType;
  /** How the session was minted (AuthSessionCreatedVia) or the signup strategy. */
  method: string;
  createdAt: Date;
  updatedAt: Date; // Required by Document constraint; not auto-set (timestamps.updatedAt: false)
}

export type CreateAuthEventInput = INetworkMeta & {
  userId: string;
  type: AuthEventType;
  method: string;
};

const AuthEventSchema = new Schema<IAuthEventDocument>(
  {
    userId: { type: String, required: true },
    type: { type: String, required: true, enum: AUTH_EVENT_TYPES },
    method: { type: String, required: true },
    ...NETWORK_META_FIELDS,
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

AuthEventSchema.index({ userId: 1, createdAt: -1 });
AuthEventSchema.index({ type: 1, ip: 1, createdAt: -1 });
AuthEventSchema.index({ type: 1, asn: 1, createdAt: -1 });

/**
 * TTL on createdAt: raw signup/login IPs are kept for 90 days.
 *
 * Mongo does not apply a changed expireAfterSeconds to an index that already exists, so changing
 * this value needs a collMod migration (see 20260921235950_set-user-auth-audit-log-retention).
 */
export const AUTH_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

AuthEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUTH_EVENT_RETENTION_SECONDS });

export const AuthEventModel: Model<IAuthEventDocument> =
  (mongoose.models.AuthEvent as unknown as Model<IAuthEventDocument>) ??
  model<IAuthEventDocument>('AuthEvent', AuthEventSchema);

class AuthEventRepository extends BaseRepository<IAuthEventDocument> {
  constructor() {
    super(AuthEventModel);
  }

  async record(data: CreateAuthEventInput): Promise<void> {
    await this.model.create(data);
  }

  async findByUser(userId: string, limit = 50): Promise<IAuthEventDocument[]> {
    return this.model.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  }

  /**
   * Counts other accounts, not login events. A truncated scan is unknown, never a low count.
   * Without a userId every signup counts (a gate run before the account exists).
   */
  async recentDistinctSignups(input: {
    userId?: string;
    since: Date;
    until: Date;
    ip: string | null;
    asn: number | null;
    /** Skip the IPv4 /24 count (null) when the caller never reads it; defaults to counted. */
    prefix?: boolean;
    maxRows: number;
  }): Promise<{ ipSignups: number | null; asnSignups: number | null; prefixSignups: number | null }> {
    const { since, until, maxRows } = input;
    const now = Date.now();
    if (
      !Number.isFinite(since.getTime()) ||
      !Number.isFinite(until.getTime()) ||
      since >= until ||
      since.getTime() < now - AUTH_EVENT_RETENTION_SECONDS * 1000 ||
      until.getTime() > now ||
      !Number.isInteger(maxRows) ||
      maxRows < 1 ||
      maxRows > 10_000
    )
      throw new Error('Invalid signup window');

    const count = async (network: Record<string, unknown>): Promise<number | null> => {
      const rows = await this.model
        .find({
          ...network,
          type: 'signup',
          ...(input.userId === undefined ? {} : { userId: { $ne: input.userId } }),
          createdAt: { $gte: since, $lt: until },
        })
        .select({ userId: 1, _id: 0 })
        .limit(maxRows + 1)
        .maxTimeMS(2000)
        .lean();
      if (rows.length > maxRows) return null;
      return new Set(rows.map(row => row.userId)).size;
    };
    const ipVersion = input.ip === null ? 0 : isIP(input.ip);
    const prefix =
      input.prefix !== false && input.ip !== null && ipVersion === 4
        ? input.ip.slice(0, input.ip.lastIndexOf('.') + 1)
        : null;
    const [ipSignups, asnSignups, prefixSignups] = await Promise.all([
      ipVersion ? count({ ip: input.ip }) : null,
      Number.isSafeInteger(input.asn) && input.asn !== null && input.asn > 0 ? count({ asn: input.asn }) : null,
      prefix ? count({ ip: { $gte: prefix, $lt: `${prefix}~` } }) : null,
    ]);
    return { ipSignups, asnSignups, prefixSignups };
  }

  /** The account's signup rows since `since`, for the deletion-time SignupTrace. */
  async findSignupsSince(userId: string, since: Date): Promise<Pick<IAuthEventDocument, 'ip' | 'asn' | 'createdAt'>[]> {
    return this.model
      .find({ userId, type: 'signup', createdAt: { $gte: since } })
      .select({ ip: 1, asn: 1, createdAt: 1, _id: 0 })
      .lean();
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.model.deleteMany({ userId });
    return result.deletedCount;
  }
}

export const authEventRepository = new AuthEventRepository();
