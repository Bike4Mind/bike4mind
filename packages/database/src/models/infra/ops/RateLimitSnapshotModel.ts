import { IMongoDocument, RATE_LIMIT_INTEGRATIONS, type RateLimitIntegrationType } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export type IntegrationType = RateLimitIntegrationType;

export interface IRateLimitSnapshotDocument extends IMongoDocument {
  integration: IntegrationType;
  userId: string;
  endpoint: string;
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
  usagePercent: number | null;
  wasThrottled: boolean;
  retryAfterMs: number | null;
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RateLimitSnapshotSchema = new mongoose.Schema<IRateLimitSnapshotDocument>(
  {
    integration: {
      type: String,
      required: true,
      enum: [...RATE_LIMIT_INTEGRATIONS],
      index: true,
    },
    userId: { type: String, required: true, index: true },
    endpoint: { type: String, required: true },
    limit: { type: Number, default: null },
    remaining: { type: Number, default: null },
    resetAt: { type: Date, default: null },
    usagePercent: { type: Number, default: null },
    wasThrottled: { type: Boolean, required: true, default: false },
    retryAfterMs: { type: Number, default: null },
    timestamp: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true }
);

// Primary query pattern: latest snapshots per integration per user
RateLimitSnapshotSchema.index({ integration: 1, userId: 1, timestamp: -1 });

// Find near-limit integrations across all users
RateLimitSnapshotSchema.index({ integration: 1, usagePercent: -1 });

// Find throttled events for audit
RateLimitSnapshotSchema.index({ wasThrottled: 1, timestamp: -1 });

// TTL index: auto-delete snapshots older than 30 days
RateLimitSnapshotSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const RateLimitSnapshot: Model<IRateLimitSnapshotDocument> =
  mongoose.models.RateLimitSnapshot ||
  mongoose.model<IRateLimitSnapshotDocument>('RateLimitSnapshot', RateLimitSnapshotSchema);

export class RateLimitSnapshotRepository extends BaseRepository<IRateLimitSnapshotDocument> {
  constructor(model: Model<IRateLimitSnapshotDocument>) {
    super(model);
  }

  /**
   * Get the most recent snapshot for an integration and user
   */
  async getLatestByIntegration(
    integration: IntegrationType,
    userId: string
  ): Promise<IRateLimitSnapshotDocument | null> {
    return this.model.findOne({ integration, userId }).sort({ timestamp: -1 }).exec();
  }

  /**
   * Get historical snapshots for an integration and user within a date range
   */
  async getHistory(
    integration: IntegrationType,
    userId: string,
    startDate: Date,
    endDate: Date,
    limit = 500
  ): Promise<IRateLimitSnapshotDocument[]> {
    return this.model
      .find({
        integration,
        userId,
        timestamp: { $gte: startDate, $lte: endDate },
      })
      .sort({ timestamp: -1 })
      .limit(limit)
      .exec();
  }

  /**
   * Get all throttled (429) events within a date range
   */
  async getThrottledEvents(startDate: Date, endDate: Date, limit = 200): Promise<IRateLimitSnapshotDocument[]> {
    return this.model
      .find({
        wasThrottled: true,
        timestamp: { $gte: startDate, $lte: endDate },
      })
      .sort({ timestamp: -1 })
      .limit(limit)
      .exec();
  }

  /**
   * Get the latest snapshot for each integration for a user
   */
  async getLatestPerIntegration(userId: string): Promise<IRateLimitSnapshotDocument[]> {
    return this.model.aggregate([
      { $match: { userId } },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: '$integration',
          doc: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$doc' } },
    ]);
  }
}

export const rateLimitSnapshotRepository = new RateLimitSnapshotRepository(RateLimitSnapshot);
