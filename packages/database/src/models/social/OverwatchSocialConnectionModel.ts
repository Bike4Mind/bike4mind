import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { IMongoDocument } from '@bike4mind/common';

export type SocialConnectionStatus = 'active' | 'error' | 'requires_reauth' | 'revoked';

/** Single source of truth for supported social platforms - schema enum and SocialPlatform type both derive from this. */
export const SOCIAL_PLATFORMS = ['youtube', 'linkedin', 'x', 'facebook', 'instagram', 'reddit', 'bluesky'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface IOverwatchSocialConnectionDocument extends IMongoDocument {
  productId: string;
  platform: SocialPlatform;
  /** Encrypted OAuth access token - excluded by default (select: false) */
  accessToken?: string;
  /** Encrypted OAuth refresh token - excluded by default (select: false) */
  refreshToken?: string;
  expiresAt?: Date;
  /** Distributed lock: set to future Date while a refresh is in flight */
  refreshingUntil?: Date;
  handle?: string;
  metadata?: Record<string, unknown>;
  status: SocialConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
}

const OverwatchSocialConnectionSchema = new Schema<IOverwatchSocialConnectionDocument>(
  {
    productId: { type: String, required: true },
    platform: {
      type: String,
      enum: SOCIAL_PLATFORMS,
      required: true,
    },
    accessToken: { type: String, select: false }, // encrypted, excluded by default
    refreshToken: { type: String, select: false }, // encrypted, excluded by default
    expiresAt: { type: Date },
    refreshingUntil: { type: Date },
    handle: { type: String },
    metadata: { type: Schema.Types.Mixed },
    status: {
      type: String,
      enum: ['active', 'error', 'requires_reauth', 'revoked'],
      default: 'active',
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// One connection per platform per product - intentional business rule: Mission Control manages a
// single canonical social account per platform (e.g. one YouTube channel per product).
OverwatchSocialConnectionSchema.index(
  { productId: 1, platform: 1 },
  { unique: true, name: 'overwatch_social_connection_product_platform' }
);
// Compound index for cron handler: { status: 'active', expiresAt: { $lte: now + buffer } } - avoids post-filter scan.
// status-only queries use this index via the leading key; no standalone { status: 1 } needed.
OverwatchSocialConnectionSchema.index(
  { status: 1, expiresAt: 1 },
  { name: 'overwatch_social_connection_status_expires' }
);

export interface IOverwatchSocialConnectionModel extends Model<IOverwatchSocialConnectionDocument & IMongoDocument> {}

export const OverwatchSocialConnection: IOverwatchSocialConnectionModel =
  mongoose.models.OverwatchSocialConnection ??
  model<IOverwatchSocialConnectionDocument>('OverwatchSocialConnection', OverwatchSocialConnectionSchema);

class OverwatchSocialConnectionRepository extends BaseRepository<IOverwatchSocialConnectionDocument & IMongoDocument> {
  constructor() {
    super(OverwatchSocialConnection);
  }

  async getByProductAndPlatform(
    productId: string,
    platform: string
  ): Promise<(IOverwatchSocialConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findOne({ productId, platform });
    return result?.toJSON() ?? null;
  }

  /** Like getByProductAndPlatform but includes the encrypted accessToken field. */
  async getByProductAndPlatformWithAccessToken(
    productId: string,
    platform: string
  ): Promise<(IOverwatchSocialConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findOne({ productId, platform }).select('+accessToken');
    return result?.toJSON() ?? null;
  }

  /**
   * Bulk-load connections for a set of products on one platform - used by the
   * config GET to assemble per-product connection status without N round-trips.
   * Credentials are NOT selected; safe to include in API responses.
   */
  async listByProductsAndPlatform(
    productIds: string[],
    platform: string
  ): Promise<(IOverwatchSocialConnectionDocument & IMongoDocument)[]> {
    if (!productIds.length) return [];
    const results = await this.model.find({ productId: { $in: productIds }, platform });
    return results.map(doc => doc.toJSON());
  }

  /** Returns the document without credential fields (accessToken/refreshToken remain excluded). */
  async getById(id: string): Promise<(IOverwatchSocialConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findById(id);
    return result?.toJSON() ?? null;
  }

  /**
   * Returns the document including accessToken and refreshToken (normally excluded by select:false).
   *
   * Tokens are encrypted with the Lumina5-wide SECRET_ENCRYPTION_KEY (AES-256-GCM).
   * A dedicated KMS key per product is required before production OAuth tokens flow;
   * that migration must complete before the OAuth callback routes ship.
   */
  async getByIdWithCredentials(id: string): Promise<(IOverwatchSocialConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findById(id).select('+accessToken +refreshToken');
    return result?.toJSON() ?? null;
  }

  /**
   * Returns the document including only accessToken (normally excluded by select:false).
   * Use when only the access token is needed and the refresh token should not be loaded.
   */
  async getByIdWithAccessToken(id: string): Promise<(IOverwatchSocialConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findById(id).select('+accessToken');
    return result?.toJSON() ?? null;
  }

  /** Upserts a connection; on E11000 duplicate key, retries once as an update. */
  async upsertConnection(
    productId: string,
    platform: string,
    data: Partial<IOverwatchSocialConnectionDocument>
  ): Promise<IOverwatchSocialConnectionDocument & IMongoDocument> {
    try {
      const result = await this.model.findOneAndUpdate(
        { productId, platform },
        { $set: { ...data, productId, platform } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return result!.toJSON();
    } catch (err: unknown) {
      const mongoErr = err as { code?: number };
      if (mongoErr.code === 11000) {
        // Race: document was inserted by another Lambda - retry as plain update.
        // Mirror primary path: override productId/platform so caller-supplied data can't corrupt partition keys.
        const result = await this.model.findOneAndUpdate(
          { productId, platform },
          { $set: { ...data, productId, platform } },
          { new: true }
        );
        if (!result) throw new Error('upsertConnection: document disappeared after E11000');
        return result.toJSON();
      }
      throw err;
    }
  }

  async setStatus(id: string, status: SocialConnectionStatus, lastError?: string): Promise<void> {
    const update: Record<string, unknown> = { status };
    // Use dot notation to avoid replacing the entire metadata object (would destroy
    // previousRefreshToken and other recovery fields stored there)
    if (lastError !== undefined) update['metadata.lastError'] = lastError;
    await this.model.updateOne({ _id: id }, { $set: update });
    // Structured log - enables CloudWatch metric filters for connection health monitoring
    // without requiring a code deploy at go-live.
    console.log(JSON.stringify({ metric: 'overwatch.connection.status_change', connectionId: id, status, lastError }));
  }

  /**
   * Marks a connection 'revoked' and clears its stored credentials.
   * Called from the disconnect flow AFTER best-effort platform-side token revocation.
   * $unset removes the encrypted accessToken/refreshToken so a leaked DB backup yields no usable
   * tokens. Idempotent: a no-op if the document is already gone.
   */
  async revokeConnection(id: string): Promise<void> {
    const result = await this.model.updateOne(
      { _id: id },
      { $set: { status: 'revoked' }, $unset: { accessToken: '', refreshToken: '' } }
    );
    // matchedCount 0 means the document was gone (e.g. deleted between read and write) - emit a
    // distinct no-op signal rather than a misleading 'status_change' that asserts a transition
    // which never happened.
    if (result.matchedCount === 0) {
      console.warn(
        JSON.stringify({ metric: 'overwatch.connection.revoke_noop', connectionId: id, reason: 'no matching document' })
      );
      return;
    }
    console.log(JSON.stringify({ metric: 'overwatch.connection.status_change', connectionId: id, status: 'revoked' }));
  }

  /**
   * Acquires a distributed refresh lock atomically.
   * Returns the locked document (with credentials) if lock was acquired, null if another Lambda holds it.
   */
  async acquireRefreshLock(
    id: string,
    // 55-65 s: base 60 s (sufficient for network round-trip + token write under latency spikes)
    // ±5 s jitter spreads simultaneous lock expirations to avoid thundering-herd on cron wake-up
    lockDurationMs = 55_000 + Math.random() * 10_000
  ): Promise<(IOverwatchSocialConnectionDocument & IMongoDocument) | null> {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + lockDurationMs);
    const result = await this.model
      .findOneAndUpdate(
        {
          _id: id,
          // Also match null: { $exists: false } does NOT match null in MongoDB, so a future
          // code path that sets refreshingUntil: null instead of $unsetting it would permanently
          // stick the lock. releaseRefreshLock uses $unset (correct), but be defensive.
          $or: [{ refreshingUntil: { $exists: false } }, { refreshingUntil: null }, { refreshingUntil: { $lte: now } }],
        },
        { $set: { refreshingUntil: lockUntil } },
        { new: true }
      )
      .select('+accessToken +refreshToken');
    return result?.toJSON() ?? null;
  }

  async releaseRefreshLock(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $unset: { refreshingUntil: '' } });
  }

  // TODO(BLOCKER): must implement cursor-based pagination before merging cron handler.
  // Deployments with >100 active connections will silently skip some with a hard limit.
  async getActiveConnections(limit = 100): Promise<(IOverwatchSocialConnectionDocument & IMongoDocument)[]> {
    // Fetch limit+1 to detect truncation without a false positive at exactly `limit` docs
    const results = await this.model.find({ status: 'active' }).limit(limit + 1);
    const truncated = results.length > limit;
    if (truncated) {
      results.pop();
      console.warn(
        JSON.stringify({
          metric: 'overwatch.active_connections.truncated',
          limit,
          message:
            'Result set hit hard limit — some connections may have been skipped. Cursor pagination required before token-refresh cron ships (#8080).',
        })
      );
    }
    return results.map(doc => doc.toJSON());
  }
}

export const overwatchSocialConnectionRepository = new OverwatchSocialConnectionRepository();
