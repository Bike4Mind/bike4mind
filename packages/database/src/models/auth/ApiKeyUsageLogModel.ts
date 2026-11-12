import {
  API_KEY_COMPLETION_SOURCES,
  API_COMPLETION_OUTCOMES,
  type ApiCompletionObservation,
  type ApiKeyBillingOwnerType,
  type ApiKeyCompletionSource,
  CreditHolderType,
  IApiKeyEndpointTraffic,
  IEndpointUsageBucket,
  IEndpointUsageDay,
  IMongoDocument,
  IPlatformEndpointUsage,
} from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { User } from './UserModel';

export interface IApiKeyUsageLogDocument extends IMongoDocument {
  keyId: string;
  userId: string;
  timestamp: Date;
  ipAddress: string;
  endpoint: string;
  method: string;
  responseTime: number;
  statusCode: number;
  /**
   * Stamped at log time; rows written before these fields existed carry neither,
   * so they drop out of a source/ownerType-filtered rollup.
   */
  source?: ApiKeyCompletionSource;
  /** The key's billing owner when the request was made (same rule as reserveRequestCredits). */
  ownerType?: ApiKeyBillingOwnerType;
  completionObservation?: ApiCompletionObservation;
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
    completionObservation: {
      type: new mongoose.Schema(
        {
          requestId: { type: String, required: true, maxlength: 128 },
          requestedModel: { type: String, required: true, maxlength: 256 },
          startedAt: { type: String, required: true },
          outcome: { type: String, required: true, enum: API_COMPLETION_OUTCOMES },
        },
        { _id: false }
      ),
      default: undefined,
    },
    source: { type: String, enum: API_KEY_COMPLETION_SOURCES },
    ownerType: { type: String, enum: [CreditHolderType.User, CreditHolderType.Organization] },
  },
  { timestamps: true }
);

// Add indexes for performance - user-scoped queries
ApiKeyUsageLogSchema.index({ userId: 1, keyId: 1, timestamp: -1, _id: -1 });
ApiKeyUsageLogSchema.index({ userId: 1, timestamp: -1, _id: -1 });
ApiKeyUsageLogSchema.index({ keyId: 1, timestamp: -1 });
ApiKeyUsageLogSchema.index({ ipAddress: 1, timestamp: -1 }, { name: 'api_usage_ip_search' });
// Platform endpoint rollup filtered by source and/or ownerType (platformEndpointUsage).
// An ownerType-only filter has no source prefix, so it range-scans the timestamp TTL index instead.
ApiKeyUsageLogSchema.index({ source: 1, ownerType: 1, timestamp: -1 });

// TTL index to auto-delete logs older than 90 days
ApiKeyUsageLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const ApiKeyUsageLog: Model<IApiKeyUsageLogDocument> =
  mongoose.models.ApiKeyUsageLog || mongoose.model<IApiKeyUsageLogDocument>('ApiKeyUsageLog', ApiKeyUsageLogSchema);

export class ApiKeyUsageLogRepository extends BaseRepository<IApiKeyUsageLogDocument> {
  constructor(model: Model<IApiKeyUsageLogDocument>) {
    super(model);
  }

  /** A server-owned log id keeps caller correlation ids from deduplicating independent calls. */
  async beginCompletionObservation(
    input: Pick<
      IApiKeyUsageLogDocument,
      'keyId' | 'userId' | 'ipAddress' | 'endpoint' | 'method' | 'source' | 'ownerType' | 'completionObservation'
    >
  ): Promise<string | null> {
    const available = () =>
      User.exists({ _id: input.userId, deletedAt: null, 'deletion.purgeStartedAt': null }).maxTimeMS(2_000);
    const id = new mongoose.Types.ObjectId();
    await this.model.updateOne(
      { _id: id },
      { $setOnInsert: { ...input, timestamp: new Date(), responseTime: 0, statusCode: 0 } },
      { upsert: true, maxTimeMS: 2_000 }
    );
    try {
      if (await available()) return String(id);
    } catch (error) {
      try {
        await this.model.deleteOne({ _id: id }).maxTimeMS(2_000);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Completion start reconciliation failed');
      }
      throw error;
    }
    await this.model.deleteOne({ _id: id }).maxTimeMS(2_000);
    return null;
  }

  async finishCompletionObservation(
    id: string,
    userId: string,
    input: Pick<IApiKeyUsageLogDocument, 'statusCode' | 'responseTime' | 'completionObservation'>
  ): Promise<void> {
    // Never upsert: account purge may have removed the start row while the request was running.
    await this.model.updateOne(
      { _id: id, userId },
      { $set: { ...input, timestamp: new Date() } },
      { maxTimeMS: 2_000 }
    );
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
    const timedLogs = logs.filter(log => log.statusCode !== 0);
    const avgResponseTime =
      timedLogs.length > 0 ? timedLogs.reduce((sum, log) => sum + log.responseTime, 0) / timedLogs.length : 0;
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
   * Per-key request counts over the trailing 24 hours and 7 days, in a single aggregation
   * bounded by the {userId, keyId, timestamp} index. Keys with no requests in 7 days are absent.
   */
  async countRequestsByKeyWindows(
    userId: string,
    now: Date
  ): Promise<Record<string, { last24h: number; last7d: number }>> {
    const from24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const from7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const rows = await this.model.aggregate<{ _id: string; last24h: number; last7d: number }>([
      { $match: { userId, timestamp: { $gte: from7d, $lte: now } } },
      {
        $group: {
          _id: '$keyId',
          last7d: { $sum: 1 },
          last24h: { $sum: { $cond: [{ $gte: ['$timestamp', from24h] }, 1, 0] } },
        },
      },
    ]);
    return Object.fromEntries(rows.map(row => [row._id, { last24h: row.last24h, last7d: row.last7d }]));
  }

  /**
   * Platform-wide endpoint/latency rollup over a trailing window (default 30
   * days; pass `hours` for finer windows). Every row here is API-key-authed
   * traffic, so `source` only ever narrows to api vs cli (the handler decides
   * whether the section applies to other sources). `source` / `ownerType` match
   * the stamped fields, so either filter excludes rows logged before they
   * existed. Beyond the collection's 90-day TTL there is simply no data; callers
   * should clamp the window accordingly.
   *
   * `byEndpoint` groups by endpoint+method with request count, avg + p95 latency
   * (nearest-rank), and error rate (statusCode >= 400). `overTime` is daily
   * request counts. Request counts only - no credits/COGS live here.
   */
  async platformEndpointUsage(
    params: {
      hours?: number;
      days?: number;
      source?: ApiKeyCompletionSource;
      ownerType?: ApiKeyBillingOwnerType;
    } = {}
  ): Promise<IPlatformEndpointUsage> {
    const { hours, days = 30, source, ownerType } = params;
    const windowMs = hours != null ? hours * 60 * 60 * 1000 : days * 24 * 60 * 60 * 1000;
    const from = new Date(Date.now() - windowMs);

    const [result] = await this.model.aggregate<{
      byEndpoint: IEndpointUsageBucket[];
      overTime: IEndpointUsageDay[];
    }>([
      { $match: { timestamp: { $gte: from }, ...(source && { source }), ...(ownerType && { ownerType }) } },
      {
        $facet: {
          byEndpoint: [
            {
              $group: {
                _id: { endpoint: '$endpoint', method: '$method' },
                requests: { $sum: 1 },
                totalResponseTime: { $sum: { $cond: [{ $gt: ['$statusCode', 0] }, '$responseTime', 0] } },
                timedRequests: { $sum: { $cond: [{ $gt: ['$statusCode', 0] }, 1, 0] } },
                errors: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
                responseTimes: { $push: { $cond: [{ $gt: ['$statusCode', 0] }, '$responseTime', null] } },
              },
            },
            {
              $addFields: {
                responseTimes: { $filter: { input: '$responseTimes', cond: { $ne: ['$$this', null] } } },
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
                  $cond: [{ $gt: ['$timedRequests', 0] }, { $divide: ['$totalResponseTime', '$timedRequests'] }, 0],
                },
                p95ResponseTimeMs: {
                  $ifNull: [{ $arrayElemAt: [{ $sortArray: { input: '$responseTimes', sortBy: 1 } }, '$p95Index'] }, 0],
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
   * window, with its request count and last use.
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
  }): Promise<IApiKeyEndpointTraffic[]> {
    const { endpointPrefix, days = 90, limit = 500 } = params;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // The prefix is operator-supplied and goes into a $regex, so escape it.
    // Without this, a prefix like `/api/a+b` silently matches the wrong routes
    // and the preflight under-reports - a false "nobody breaks".
    //
    // This is a plain string prefix, not a path-segment one: `/api/chat` also
    // matches `/api/chatbots`. Over-reporting is the safe direction here (the
    // operator re-mints a key that would not have broken), and segment-awareness
    // would break the match on templated endpoints, since `endpoint` is the route
    // template (`/api/agents/[id]`). Rows written before templating still hold the
    // raw URL, so `/api/chat?x=1` has to match too until they age out of the TTL.
    const escaped = endpointPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    return this.model.aggregate<IApiKeyEndpointTraffic>([
      { $match: { timestamp: { $gte: from }, endpoint: { $regex: `^${escaped}` } } },
      {
        $group: {
          _id: '$keyId',
          userId: { $first: '$userId' },
          requests: { $sum: 1 },
          lastUsed: { $max: '$timestamp' },
        },
      },
      {
        $project: {
          _id: 0,
          keyId: '$_id',
          userId: 1,
          requests: 1,
          lastUsed: 1,
        },
      },
      // Order by recency, NOT by request count: truncation has to discard the
      // least relevant rows, and sorting by `requests` would drop the quietest
      // keys first - the monthly and quarterly callers whose invisibility is the
      // whole reason this tool exists. The handler re-sorts by outcome anyway.
      { $sort: { lastUsed: -1 } },
      { $limit: limit },
    ]);
  }
}

export const apiKeyUsageLogRepository = new ApiKeyUsageLogRepository(ApiKeyUsageLog);
