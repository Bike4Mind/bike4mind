import {
  IWebhookAuditLogDocument,
  IWebhookAuditLogRepository,
  IWebhookAuditFilters,
  IWebhookAuditPaginationOptions,
  IWebhookAuditPaginatedResult,
  IWebhookAuditSummary,
  IWebhookAuditLog,
  WebhookAuditStatus,
} from '@bike4mind/common';
import mongoose, { Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * 90 days in seconds for TTL index
 */
const NINETY_DAYS_IN_SECONDS = 90 * 24 * 60 * 60;

/**
 * Schema for webhook audit action subdocument.
 */
const WebhookAuditActionSchema = new Schema(
  {
    type: { type: String, required: true },
    status: { type: String, enum: ['success', 'failed'], required: true },
    details: { type: Map, of: Schema.Types.Mixed },
    durationMs: { type: Number },
  },
  { _id: false }
);

/**
 * Schema for webhook audit error subdocument.
 */
const WebhookAuditErrorSchema = new Schema(
  {
    message: { type: String, required: true },
    stack: { type: String },
    code: { type: String },
  },
  { _id: false }
);

/**
 * Schema for webhook audit metadata subdocument.
 */
const WebhookAuditMetadataSchema = new Schema(
  {
    prNumber: { type: Number },
    issueNumber: { type: Number },
    action: { type: String },
    branch: { type: String },
    commitCount: { type: Number },
  },
  { _id: false }
);

/**
 * Main webhook audit log schema.
 *
 * Records detailed information about each webhook delivery for debugging,
 * compliance, and operational visibility. Uses 90-day TTL for automatic cleanup.
 */
const WebhookAuditLogSchema = new Schema<IWebhookAuditLogDocument>(
  {
    // Identity & Tracing
    deliveryId: { type: String, required: true },
    correlationId: { type: String, required: true },

    // Event Details
    event: { type: String, required: true },
    repository: { type: String, required: true },
    sender: { type: String, required: true },

    // Routing Context
    organizationId: { type: String, index: true },
    mcpServerId: { type: String, index: true },

    // Timing
    receivedAt: { type: Date, required: true, default: Date.now },
    processedAt: { type: Date },
    processingDurationMs: { type: Number },

    // Status & Security
    status: {
      type: String,
      enum: Object.values(WebhookAuditStatus),
      required: true,
      default: WebhookAuditStatus.Received,
    },
    signatureVerified: { type: Boolean, required: true, default: false },

    // Error Tracking
    error: { type: WebhookAuditErrorSchema },

    // Actions Taken
    actions: { type: [WebhookAuditActionSchema], default: [] },

    // Metadata
    metadata: { type: WebhookAuditMetadataSchema, default: {} },

    // TTL
    expiresAt: { type: Date, required: true },
  },
  {
    toJSON: {
      virtuals: true,
      transform: function (_doc, ret: Record<string, unknown>) {
        // Convert Maps to plain objects for JSON serialization
        if (ret.actions && Array.isArray(ret.actions)) {
          ret.actions = (ret.actions as Array<Record<string, unknown>>).map(action => {
            if (action.details instanceof Map) {
              return { ...action, details: Object.fromEntries(action.details) };
            }
            return action;
          });
        }
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: function (_doc, ret: Record<string, unknown>) {
        if (ret.actions && Array.isArray(ret.actions)) {
          ret.actions = (ret.actions as Array<Record<string, unknown>>).map(action => {
            if (action.details instanceof Map) {
              return { ...action, details: Object.fromEntries(action.details) };
            }
            return action;
          });
        }
        return ret;
      },
    },
    timestamps: { createdAt: true, updatedAt: true },
    versionKey: false,
  }
);

// Indexes

// Unique lookup by delivery ID
WebhookAuditLogSchema.index({ deliveryId: 1 }, { unique: true, name: 'webhook_audit_delivery_id' });

// Correlation ID for distributed tracing
WebhookAuditLogSchema.index({ correlationId: 1 }, { name: 'webhook_audit_correlation_id' });

// Repository history queries
WebhookAuditLogSchema.index({ repository: 1, receivedAt: -1 }, { name: 'webhook_audit_repo_history' });

// Event type queries
WebhookAuditLogSchema.index({ event: 1, receivedAt: -1 }, { name: 'webhook_audit_event_history' });

// Status filtering
WebhookAuditLogSchema.index({ status: 1, receivedAt: -1 }, { name: 'webhook_audit_status_history' });

// Organization scoped queries
WebhookAuditLogSchema.index({ organizationId: 1, receivedAt: -1 }, { name: 'webhook_audit_org_history' });

// MCP server scoped queries
WebhookAuditLogSchema.index({ mcpServerId: 1, receivedAt: -1 }, { name: 'webhook_audit_mcp_history' });

// Time-based sorting
WebhookAuditLogSchema.index({ receivedAt: -1 }, { name: 'webhook_audit_time' });

// Compound indexes for common query patterns
WebhookAuditLogSchema.index(
  { organizationId: 1, status: 1, receivedAt: -1 },
  { name: 'webhook_audit_org_status_time' }
);
WebhookAuditLogSchema.index({ repository: 1, status: 1, receivedAt: -1 }, { name: 'webhook_audit_repo_status_time' });

// TTL index for automatic cleanup (90 days)
WebhookAuditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'webhook_audit_ttl' });

// Repository

class WebhookAuditLogRepository extends BaseRepository<IWebhookAuditLogDocument> implements IWebhookAuditLogRepository {
  constructor() {
    super(WebhookAuditLogModel);
  }

  /**
   * Create a new audit log entry.
   * Sets expiresAt to receivedAt + 90 days if not provided.
   */
  async createLog(data: Partial<IWebhookAuditLog>): Promise<IWebhookAuditLogDocument> {
    const receivedAt = data.receivedAt || new Date();
    const expiresAt = data.expiresAt || new Date(receivedAt.getTime() + NINETY_DAYS_IN_SECONDS * 1000);

    const result = await this.model.create({
      ...data,
      receivedAt,
      expiresAt,
      actions: data.actions || [],
      metadata: data.metadata || {},
    });

    return result.toJSON() as IWebhookAuditLogDocument;
  }

  /**
   * Update an existing audit log by delivery ID.
   * Uses upsert to handle duplicate processing scenarios.
   */
  async updateByDeliveryId(
    deliveryId: string,
    update: Partial<IWebhookAuditLog>
  ): Promise<IWebhookAuditLogDocument | null> {
    const result = await this.model.findOneAndUpdate({ deliveryId }, { $set: update }, { new: true, upsert: false });

    return result?.toJSON() as IWebhookAuditLogDocument | null;
  }

  /**
   * Add an action to an existing audit log.
   */
  async addAction(
    deliveryId: string,
    action: { type: string; status: 'success' | 'failed'; details?: Record<string, unknown>; durationMs?: number }
  ): Promise<IWebhookAuditLogDocument | null> {
    const result = await this.model.findOneAndUpdate({ deliveryId }, { $push: { actions: action } }, { new: true });

    return result?.toJSON() as IWebhookAuditLogDocument | null;
  }

  /**
   * Find an audit log by delivery ID.
   */
  async findByDeliveryId(deliveryId: string): Promise<IWebhookAuditLogDocument | null> {
    const result = await this.model.findOne({ deliveryId });
    return result?.toJSON() as IWebhookAuditLogDocument | null;
  }

  /**
   * Find audit logs with pagination and filtering.
   */
  async findByDateRange(
    startDate: Date,
    endDate: Date,
    filters: IWebhookAuditFilters = {},
    options: IWebhookAuditPaginationOptions = {}
  ): Promise<IWebhookAuditPaginatedResult> {
    const { limit = 50, cursor } = options;
    const safeLimit = Math.min(limit, 100); // Cap at 100

    // Build query conditions
    const query: Record<string, unknown> = {
      receivedAt: { $gte: startDate, $lte: endDate },
    };

    // Use regex for partial repository matching (case-insensitive)
    // Escape regex special characters to prevent injection attacks
    if (filters.repository) {
      const escaped = filters.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.repository = { $regex: escaped, $options: 'i' };
    }
    if (filters.event) query.event = filters.event;
    if (filters.status) query.status = filters.status;
    if (filters.organizationId) query.organizationId = filters.organizationId;
    if (filters.mcpServerId) query.mcpServerId = filters.mcpServerId;

    // Source type filter: 'org' = has organizationId, 'user' = has mcpServerId
    // Only apply $exists if no specific ID is already provided
    if (filters.sourceType === 'org' && !filters.organizationId) {
      query.organizationId = { $exists: true, $ne: null };
    } else if (filters.sourceType === 'user' && !filters.mcpServerId) {
      query.mcpServerId = { $exists: true, $ne: null };
    }

    // Build count query (same filters as main query, but without cursor pagination)
    const countQuery = { ...query };

    // Apply cursor for pagination (cursor is base64 encoded receivedAt timestamp)
    if (cursor) {
      try {
        const cursorDate = new Date(Buffer.from(cursor, 'base64').toString('utf8'));
        (query.receivedAt as Record<string, Date>).$lt = cursorDate;
      } catch {
        // Invalid cursor, ignore
      }
    }

    // Execute queries in parallel
    const [logs, total] = await Promise.all([
      this.model
        .find(query)
        .sort({ receivedAt: -1 })
        .limit(safeLimit + 1) // Fetch one extra to check if there are more
        .then(docs => docs.map(d => d.toJSON() as IWebhookAuditLogDocument)),
      this.model.countDocuments(countQuery),
    ]);

    // Check if there are more results
    const hasMore = logs.length > safeLimit;
    if (hasMore) {
      logs.pop(); // Remove the extra item
    }

    // Generate next cursor from last item
    const nextCursor =
      hasMore && logs.length > 0
        ? Buffer.from(logs[logs.length - 1].receivedAt.toISOString()).toString('base64')
        : null;

    return {
      logs,
      nextCursor,
      hasMore,
      total,
    };
  }

  /**
   * Get summary statistics for webhook audit logs.
   */
  async getAuditSummary(
    startDate: Date,
    endDate: Date,
    filters: IWebhookAuditFilters = {}
  ): Promise<IWebhookAuditSummary> {
    const matchConditions: Record<string, unknown> = {
      receivedAt: { $gte: startDate, $lte: endDate },
    };

    // Use regex for partial repository matching (case-insensitive)
    // Escape regex special characters to prevent injection attacks
    if (filters.repository) {
      const escaped = filters.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matchConditions.repository = { $regex: escaped, $options: 'i' };
    }
    if (filters.event) matchConditions.event = filters.event;
    if (filters.status) matchConditions.status = filters.status;
    if (filters.organizationId) matchConditions.organizationId = filters.organizationId;
    if (filters.mcpServerId) matchConditions.mcpServerId = filters.mcpServerId;

    // Source type filter: 'org' = has organizationId, 'user' = has mcpServerId
    // Only apply $exists if no specific ID is already provided
    if (filters.sourceType === 'org' && !filters.organizationId) {
      matchConditions.organizationId = { $exists: true, $ne: null };
    } else if (filters.sourceType === 'user' && !filters.mcpServerId) {
      matchConditions.mcpServerId = { $exists: true, $ne: null };
    }

    const [totalStats, successStats, failureStats, durationStats, eventStats, statusStats, errorStats, hourlyStats] =
      await Promise.all([
        // Total count
        this.model.countDocuments(matchConditions),

        // Success count
        this.model.countDocuments({ ...matchConditions, status: WebhookAuditStatus.Completed }),

        // Failure count
        this.model.countDocuments({ ...matchConditions, status: WebhookAuditStatus.Failed }),

        // Duration stats (avg and p95)
        this.model.aggregate([
          { $match: { ...matchConditions, processingDurationMs: { $exists: true, $ne: null } } },
          {
            $group: {
              _id: null,
              avgDuration: { $avg: '$processingDurationMs' },
              durations: { $push: '$processingDurationMs' },
            },
          },
        ]),

        // Event type breakdown
        this.model.aggregate([{ $match: matchConditions }, { $group: { _id: '$event', count: { $sum: 1 } } }]),

        // Status breakdown
        this.model.aggregate([{ $match: matchConditions }, { $group: { _id: '$status', count: { $sum: 1 } } }]),

        // Error breakdown (top 10 error messages)
        this.model.aggregate([
          { $match: { ...matchConditions, 'error.message': { $exists: true } } },
          { $group: { _id: '$error.message', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ]),

        // Hourly trend
        this.model.aggregate([
          { $match: matchConditions },
          {
            $group: {
              _id: {
                $dateToString: { format: '%Y-%m-%dT%H:00:00Z', date: '$receivedAt' },
              },
              count: { $sum: 1 },
              successCount: {
                $sum: { $cond: [{ $eq: ['$status', WebhookAuditStatus.Completed] }, 1, 0] },
              },
            },
          },
          { $sort: { _id: 1 } },
        ]),
      ]);

    // Calculate P95 from durations array
    let p95Duration = 0;
    if (durationStats.length > 0 && durationStats[0].durations?.length > 0) {
      const sortedDurations = [...durationStats[0].durations].sort((a, b) => a - b);
      const p95Index = Math.floor(sortedDurations.length * 0.95);
      p95Duration = sortedDurations[Math.min(p95Index, sortedDurations.length - 1)] || 0;
    }

    // Success rate can only be meaningfully calculated when no status filter is applied.
    // When filtering by status, the total count represents only items of that status,
    // not all deliveries, making the rate calculation misleading or impossible
    // (e.g., 8800% when filtering by 'processing' status).
    const canCalculateSuccessRate = !filters.status;

    return {
      totalDeliveries: totalStats,
      successCount: successStats,
      failureCount: failureStats,
      successRate: canCalculateSuccessRate ? (totalStats > 0 ? (successStats / totalStats) * 100 : 100) : null,
      avgProcessingDurationMs: durationStats.length > 0 ? durationStats[0].avgDuration || 0 : 0,
      p95ProcessingDurationMs: p95Duration,
      eventBreakdown: eventStats.reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        {} as Record<string, number>
      ),
      statusBreakdown: statusStats.reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        {} as Record<string, number>
      ),
      errorBreakdown: errorStats.reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        {} as Record<string, number>
      ),
      hourlyTrend: hourlyStats.map(item => ({
        hour: item._id,
        count: item.count,
        successRate: canCalculateSuccessRate ? (item.count > 0 ? (item.successCount / item.count) * 100 : 100) : null,
      })),
    };
  }

  /**
   * Manual cleanup of old logs (backup for TTL).
   */
  async cleanupOldLogs(olderThanDays: number): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.model.deleteMany({ receivedAt: { $lt: cutoffDate } });
    return result.deletedCount || 0;
  }
}

// Model Export

export const WebhookAuditLogModel: Model<IWebhookAuditLogDocument> =
  (mongoose.models.WebhookAuditLog as unknown as Model<IWebhookAuditLogDocument>) ??
  model<IWebhookAuditLogDocument>('WebhookAuditLog', WebhookAuditLogSchema);

export const webhookAuditLogRepository = new WebhookAuditLogRepository();
