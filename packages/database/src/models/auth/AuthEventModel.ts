import mongoose, { Document, Model, model, Schema } from 'mongoose';
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

  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.model.deleteMany({ userId });
    return result.deletedCount;
  }
}

export const authEventRepository = new AuthEventRepository();
