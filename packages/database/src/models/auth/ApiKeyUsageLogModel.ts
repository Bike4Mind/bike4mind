import {
  IApiKeyEndpointTraffic,
  IEndpointUsageBucket,
  IEndpointUsageDay,
  IMongoDocument,
  IPlatformEndpointUsage,
} from '@bike4mind/common';
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

  /**
   * Count logged requests per API key for a user, in a single aggregation.
   * Returns each key's lifetime total (bounded by this collection's 90-day TTL)
   * and today's count (timestamp >= dayStart). Backs the API-key usage view with
   * real request data instead of the never-written UserApiKey.usage counters (#773).
   * Keys with no logged requests are simply absent from the result.
   */
  async countRequestsByKeyForUser(
    userId: string,
    dayStart: Date
  ): Promise<Record<string, { totalRequests: number; requestsToday: number }>> {
    const rows = await this.model.aggregate<{
      _id: string;
      totalRequests: number;
      requestsToday: number;
    }>([
      { $match: { userId } },
      {
        $group: {
          _id: '$keyId',
          totalRequests: { $sum: 1 },
          requestsToday: { $sum: { $cond: [{ $gte: ['$timestamp', dayStart] }, 1, 0] } },
        },
      },
    ]);

    return rows.reduce<Record<string, { totalRequests: number; requestsToday: number }>>((acc, row) => {
      acc[row._id] = { totalRequests: row.totalRequests, requestsToday: row.requestsToday };
      return acc;
    }, {});
  }

  /**
   * Platform-wide endpoint/latency rollup over a trailing window (default 30
   * days; pass `hours` for finer windows). Every row here is API-key-authed
   * traffic - this collection logs nothing else - so there is no source
   * dimension to filter on (the handler decides whether the endpoint section
   * applies given the user's source filter). Beyond the collection's 90-day TTL
   * there is simply no data; callers should clamp the window accordingly.
   *
   * `byEndpoint` groups by endpoint+method with request count, avg + p95 latency
   * (nearest-rank), and error rate (statusCode >= 400). `overTime` is daily
   * request counts. Request counts only - no credits/COGS live here.
   */
  async platformEndpointUsage(params: { hours?: number; days?: number } = {}): Promise<IPlatformEndpointUsage> {
    const { hours, days = 30 } = params;
    const windowMs = hours != null ? hours * 60 * 60 * 1000 : days * 24 * 60 * 60 * 1000;
    const from = new Date(Date.now() - windowMs);

    const [result] = await this.model.aggregate<{
      byEndpoint: IEndpointUsageBucket[];
      overTime: IEndpointUsageDay[];
    }>([
      { $match: { timestamp: { $gte: from } } },
      {
        $facet: {
          byEndpoint: [
            {
              $group: {
                _id: { endpoint: '$endpoint', method: '$method' },
                requests: { $sum: 1 },
                totalResponseTime: { $sum: '$responseTime' },
                errors: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
                responseTimes: { $push: '$responseTime' },
              },
            },
            {
              // Nearest-rank p95: sort ascending, take element ceil(0.95 * n) - 1,
              // clamped into range. $sortArray keeps this in-pipeline (no $unwind).
              $addFields: {
                p95Index: {
                  $min: [
                    { $subtract: [{ $size: '$responseTimes' }, 1] },
                    { $max: [0, { $subtract: [{ $ceil: { $multiply: [0.95, { $size: '$responseTimes' }] } }, 1] }] },
                  ],
                },
              },
            },
            {
              $project: {
                _id: 0,
                endpoint: '$_id.endpoint',
                method: '$_id.method',
                requests: 1,
                avgResponseTimeMs: {
                  $cond: [{ $gt: ['$requests', 0] }, { $divide: ['$totalResponseTime', '$requests'] }, 0],
                },
                p95ResponseTimeMs: {
                  $arrayElemAt: [{ $sortArray: { input: '$responseTimes', sortBy: 1 } }, '$p95Index'],
                },
                errorRate: { $cond: [{ $gt: ['$requests', 0] }, { $divide: ['$errors', '$requests'] }, 0] },
              },
            },
            { $sort: { requests: -1 } },
          ],
          overTime: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: 'UTC' } },
                requests: { $sum: 1 },
              },
            },
            { $project: { _id: 0, day: '$_id', requests: 1 } },
            { $sort: { day: 1 } },
          ],
        },
      },
    ]);

    return {
      byEndpoint: result?.byEndpoint ?? [],
      overTime: result?.overTime ?? [],
    };
  }

  /**
   * Every API key that has called a route under `endpointPrefix` within the
   * window, with its request count, last use, and the distinct endpoints it hit.
   *
   * This is the evidence half of a scope-enforcement preflight: before declaring
   * `requiredScopes` on routes that are currently scope-less, you need the list
   * of keys already calling them, because a key holds only what it was minted
   * with and will 403 the moment the gate enforces. Deciding which of these keys
   * would actually break is the caller's job - it must ask `decideScopeGate`
   * rather than compare scope arrays itself.
   *
   * Note there is NO index on `endpoint` (see the schema's index block), so this
   * is a collection scan bounded by the timestamp match. That is tolerable
   * because the collection carries a 90-day TTL and this runs a handful of times
   * per scope rollout, not on a request path. Add a compound index if that
   * changes.
   */
  async findKeyTrafficByEndpointPrefix(params: {
    endpointPrefix: string;
    days?: number;
    /** Max keys returned; the caller should surface truncation to the operator. */
    limit?: number;
    /** Distinct endpoints kept per key, for display. */
    endpointsPerKey?: number;
  }): Promise<IApiKeyEndpointTraffic[]> {
    const { endpointPrefix, days = 90, limit = 500, endpointsPerKey = 10 } = params;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // The prefix is operator-supplied and goes into a $regex, so escape it.
    // Without this, a prefix like `/api/a+b` silently matches the wrong routes
    // and the preflight under-reports - a false "nobody breaks".
    const escaped = endpointPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    return this.model.aggregate<IApiKeyEndpointTraffic>([
      { $match: { timestamp: { $gte: from }, endpoint: { $regex: `^${escaped}` } } },
      {
        $group: {
          _id: '$keyId',
          userId: { $first: '$userId' },
          requests: { $sum: 1 },
          lastUsed: { $max: '$timestamp' },
          endpoints: { $addToSet: '$endpoint' },
        },
      },
      {
        $project: {
          _id: 0,
          keyId: '$_id',
          userId: 1,
          requests: 1,
          lastUsed: 1,
          endpoints: { $slice: ['$endpoints', endpointsPerKey] },
        },
      },
      { $sort: { requests: -1 } },
      { $limit: limit },
    ]);
  }
}

export const apiKeyUsageLogRepository = new ApiKeyUsageLogRepository(ApiKeyUsageLog);
