import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IApiKeyUsageLogDocument extends IMongoDocument {
  keyId: string;
  userId: string;
  timestamp: Date;
  ipAddress: string;
  endpoint: string;
  method: string;
  responseTime: number;
  statusCode: number;
  createdAt: Date;
  updatedAt: Date;
}

const ApiKeyUsageLogSchema = new mongoose.Schema<IApiKeyUsageLogDocument>(
  {
    keyId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    timestamp: { type: Date, required: true, default: () => new Date() }, // Index created below for TTL
    ipAddress: { type: String, required: true },
    endpoint: { type: String, required: true },
    method: { type: String, required: true },
    responseTime: { type: Number, required: true },
    statusCode: { type: Number, required: true },
  },
  { timestamps: true }
);

// Add indexes for performance - user-scoped queries
ApiKeyUsageLogSchema.index({ userId: 1, keyId: 1, timestamp: -1 });
ApiKeyUsageLogSchema.index({ userId: 1, timestamp: -1 });
ApiKeyUsageLogSchema.index({ keyId: 1, timestamp: -1 });

// TTL index to auto-delete logs older than 90 days
ApiKeyUsageLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const ApiKeyUsageLog: Model<IApiKeyUsageLogDocument> =
  mongoose.models.ApiKeyUsageLog || mongoose.model<IApiKeyUsageLogDocument>('ApiKeyUsageLog', ApiKeyUsageLogSchema);

export class ApiKeyUsageLogRepository extends BaseRepository<IApiKeyUsageLogDocument> {
  constructor(model: Model<IApiKeyUsageLogDocument>) {
    super(model);
  }

  /**
   * Get usage logs for a specific user's API key
   */
  async findByUserIdAndKeyId(userId: string, keyId: string, limit = 100): Promise<IApiKeyUsageLogDocument[]> {
    return this.model.find({ userId, keyId }).sort({ timestamp: -1 }).limit(limit).exec();
  }

  /**
   * Get usage logs for a user (all their API keys)
   */
  async findByUserId(userId: string, limit = 100): Promise<IApiKeyUsageLogDocument[]> {
    return this.model.find({ userId }).sort({ timestamp: -1 }).limit(limit).exec();
  }

  /**
   * Get usage stats for a specific key within a time range
   */
  async getUsageStats(
    userId: string,
    keyId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    totalRequests: number;
    avgResponseTime: number;
    uniqueIPs: string[];
    requestsPerMinute: number;
  }> {
    const logs = await this.model
      .find({
        userId,
        keyId,
        timestamp: { $gte: startDate, $lte: endDate },
      })
      .exec();

    const totalRequests = logs.length;
    const avgResponseTime =
      totalRequests > 0 ? logs.reduce((sum, log) => sum + log.responseTime, 0) / totalRequests : 0;
    const uniqueIPs = Array.from(new Set(logs.map(log => log.ipAddress)));
    const timeRangeMinutes = (endDate.getTime() - startDate.getTime()) / (1000 * 60);
    const requestsPerMinute = timeRangeMinutes > 0 ? totalRequests / timeRangeMinutes : 0;

    return {
      totalRequests,
      avgResponseTime,
      uniqueIPs,
      requestsPerMinute,
    };
  }

  /**
   * Get recent requests per minute for a key
   */
  async getRecentRequestsPerMinute(userId: string, keyId: string, minutes = 1): Promise<number> {
    const startDate = new Date(Date.now() - minutes * 60 * 1000);
    const count = await this.model.countDocuments({
      userId,
      keyId,
      timestamp: { $gte: startDate },
    });
    return count / minutes;
  }

  /**
   * Get usage logs for a user's API key within a date range
   * Used for baseline calculation
   */
  async findByUserIdAndKeyIdInDateRange(
    userId: string,
    keyId: string,
    startDate: Date,
    endDate: Date
  ): Promise<IApiKeyUsageLogDocument[]> {
    return this.model
      .find({
        userId,
        keyId,
        timestamp: { $gte: startDate, $lte: endDate },
      })
      .exec();
  }
}

export const apiKeyUsageLogRepository = new ApiKeyUsageLogRepository(ApiKeyUsageLog);
