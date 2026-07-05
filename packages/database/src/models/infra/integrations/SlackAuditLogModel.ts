import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Event types for Slack audit logging
 */
export type SlackAuditEventType = 'command' | 'interaction' | 'event' | 'api_call';

/**
 * Common actions performed in Slack integration
 */
export type SlackAuditAction =
  | 'execute_command'
  | 'button_click'
  | 'modal_submit'
  | 'modal_open'
  | 'app_home_opened'
  | 'message_received'
  | 'create_notebook'
  | 'view_notebook'
  | 'refresh_home'
  | 'view_settings'
  | 'view_help'
  | 'api_call';

/**
 * Resource types that can be accessed/modified
 */
export type SlackAuditResourceType =
  | 'notebook'
  | 'message'
  | 'user'
  | 'workspace'
  | 'settings'
  | 'integration'
  | 'none';

export interface ISlackAuditLogDocument extends Document {
  id: string;
  timestamp: Date;
  eventType: SlackAuditEventType;
  userId?: string; // B4M user ID (optional - user may not be linked)
  slackUserId: string;
  slackTeamId: string;
  action: string;
  resourceType: SlackAuditResourceType;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  success: boolean;
  errorMessage?: string;
  durationMs?: number; // How long the operation took
  createdAt: Date;
  updatedAt: Date;
}

export interface ISlackAuditLogRepository {
  findAll(limit?: number): Promise<ISlackAuditLogDocument[]>;
  findBySlackUser(slackUserId: string, limit?: number): Promise<ISlackAuditLogDocument[]>;
  findBySlackTeam(slackTeamId: string, limit?: number): Promise<ISlackAuditLogDocument[]>;
  findByB4MUser(userId: string, limit?: number): Promise<ISlackAuditLogDocument[]>;
  findByDateRange(
    startDate: Date,
    endDate: Date,
    filters?: {
      slackTeamId?: string;
      slackUserId?: string;
      eventType?: SlackAuditEventType;
      action?: string;
      success?: boolean;
    },
    limit?: number
  ): Promise<ISlackAuditLogDocument[]>;
  createLog(data: Partial<ISlackAuditLogDocument>): Promise<ISlackAuditLogDocument>;
  cleanupOldLogs(olderThanDays: number): Promise<number>;
  getAuditSummary(filters?: {
    startDate?: Date;
    endDate?: Date;
    slackTeamId?: string;
    slackUserId?: string;
    eventType?: SlackAuditEventType;
  }): Promise<{
    totalActions: number;
    successRate: number;
    eventTypeBreakdown: Record<string, number>;
    actionBreakdown: Record<string, number>;
    userBreakdown: Record<string, number>;
    recentActivity: ISlackAuditLogDocument[];
  }>;
}

const SlackAuditLogSchema = new Schema<ISlackAuditLogDocument>(
  {
    timestamp: { type: Date, required: true, default: Date.now },
    eventType: {
      type: String,
      required: true,
      enum: ['command', 'interaction', 'event', 'api_call'],
    },
    userId: { type: String, index: true }, // B4M user ID (optional)
    slackUserId: { type: String, required: true },
    slackTeamId: { type: String, required: true },
    action: { type: String, required: true },
    resourceType: {
      type: String,
      required: true,
      enum: ['notebook', 'message', 'user', 'workspace', 'settings', 'integration', 'none'],
      default: 'none',
    },
    resourceId: { type: String },
    metadata: { type: Map, of: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String },
    success: { type: Boolean, required: true, default: true },
    errorMessage: { type: String },
    durationMs: { type: Number },
  },
  {
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        if (ret.metadata instanceof Map) {
          ret.metadata = Object.fromEntries(ret.metadata);
        }
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: function (doc, ret) {
        if (ret.metadata instanceof Map) {
          ret.metadata = Object.fromEntries(ret.metadata);
        }
        return ret;
      },
    },
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

// Indexes for common query patterns
SlackAuditLogSchema.index({ timestamp: -1 }); // Date range queries
SlackAuditLogSchema.index({ slackUserId: 1 }); // User-specific queries
SlackAuditLogSchema.index({ slackTeamId: 1 }); // Workspace-specific queries
SlackAuditLogSchema.index({ eventType: 1 }); // Filter by type
SlackAuditLogSchema.index({ action: 1 }); // Filter by action
SlackAuditLogSchema.index({ slackTeamId: 1, timestamp: -1 }); // Compound: workspace + time
SlackAuditLogSchema.index({ slackUserId: 1, timestamp: -1 }); // Compound: user + time
SlackAuditLogSchema.index({ success: 1 }); // Filter failures

// TTL index to auto-delete old audit logs after 90 days
SlackAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

class SlackAuditLogRepository extends BaseRepository<ISlackAuditLogDocument> implements ISlackAuditLogRepository {
  constructor() {
    super(SlackAuditLogModel);
  }

  async findAll(limit = 100): Promise<ISlackAuditLogDocument[]> {
    return this.model.find({}).sort({ timestamp: -1 }).limit(limit);
  }

  async findBySlackUser(slackUserId: string, limit = 50): Promise<ISlackAuditLogDocument[]> {
    return this.model.find({ slackUserId }).sort({ timestamp: -1 }).limit(limit);
  }

  async findBySlackTeam(slackTeamId: string, limit = 50): Promise<ISlackAuditLogDocument[]> {
    return this.model.find({ slackTeamId }).sort({ timestamp: -1 }).limit(limit);
  }

  async findByB4MUser(userId: string, limit = 50): Promise<ISlackAuditLogDocument[]> {
    return this.model.find({ userId }).sort({ timestamp: -1 }).limit(limit);
  }

  async findByDateRange(
    startDate: Date,
    endDate: Date,
    filters: {
      slackTeamId?: string;
      slackUserId?: string;
      eventType?: SlackAuditEventType;
      action?: string;
      success?: boolean;
    } = {},
    limit = 100
  ): Promise<ISlackAuditLogDocument[]> {
    const query: Record<string, unknown> = {
      timestamp: { $gte: startDate, $lte: endDate },
    };

    if (filters.slackTeamId) query.slackTeamId = filters.slackTeamId;
    if (filters.slackUserId) query.slackUserId = filters.slackUserId;
    if (filters.eventType) query.eventType = filters.eventType;
    if (filters.action) query.action = filters.action;
    if (filters.success !== undefined) query.success = filters.success;

    return this.model.find(query).sort({ timestamp: -1 }).limit(limit);
  }

  async createLog(data: Partial<ISlackAuditLogDocument>): Promise<ISlackAuditLogDocument> {
    const result = await this.model.create({
      ...data,
      timestamp: data.timestamp || new Date(),
    });
    return result.toJSON() as unknown as ISlackAuditLogDocument;
  }

  async cleanupOldLogs(olderThanDays: number): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.model.deleteMany({ timestamp: { $lt: cutoffDate } });
    return result.deletedCount || 0;
  }

  async getAuditSummary(
    filters: {
      startDate?: Date;
      endDate?: Date;
      slackTeamId?: string;
      slackUserId?: string;
      eventType?: SlackAuditEventType;
    } = {}
  ): Promise<{
    totalActions: number;
    successRate: number;
    eventTypeBreakdown: Record<string, number>;
    actionBreakdown: Record<string, number>;
    userBreakdown: Record<string, number>;
    recentActivity: ISlackAuditLogDocument[];
  }> {
    const matchConditions: Record<string, unknown> = {};

    if (filters.startDate || filters.endDate) {
      matchConditions.timestamp = {};
      if (filters.startDate) (matchConditions.timestamp as Record<string, Date>).$gte = filters.startDate;
      if (filters.endDate) (matchConditions.timestamp as Record<string, Date>).$lte = filters.endDate;
    }

    if (filters.slackTeamId) matchConditions.slackTeamId = filters.slackTeamId;
    if (filters.slackUserId) matchConditions.slackUserId = filters.slackUserId;
    if (filters.eventType) matchConditions.eventType = filters.eventType;

    const [totalStats, successStats, eventTypeStats, actionStats, userStats, recentActivity] = await Promise.all([
      // Total count
      this.model.countDocuments(matchConditions),

      // Success count
      this.model.countDocuments({ ...matchConditions, success: true }),

      // Event type breakdown
      this.model.aggregate([{ $match: matchConditions }, { $group: { _id: '$eventType', count: { $sum: 1 } } }]),

      // Action breakdown
      this.model.aggregate([{ $match: matchConditions }, { $group: { _id: '$action', count: { $sum: 1 } } }]),

      // User breakdown
      this.model.aggregate([{ $match: matchConditions }, { $group: { _id: '$slackUserId', count: { $sum: 1 } } }]),

      // Recent activity
      this.model.find(matchConditions).sort({ timestamp: -1 }).limit(10),
    ]);

    return {
      totalActions: totalStats,
      successRate: totalStats > 0 ? (successStats / totalStats) * 100 : 100,
      eventTypeBreakdown: eventTypeStats.reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        {} as Record<string, number>
      ),
      actionBreakdown: actionStats.reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        {} as Record<string, number>
      ),
      userBreakdown: userStats.reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        {} as Record<string, number>
      ),
      recentActivity: recentActivity.map(log => log.toJSON()) as unknown as ISlackAuditLogDocument[],
    };
  }
}

export const SlackAuditLogModel: Model<ISlackAuditLogDocument> =
  (mongoose.models.SlackAuditLog as unknown as Model<ISlackAuditLogDocument>) ??
  model<ISlackAuditLogDocument>('SlackAuditLog', SlackAuditLogSchema);

export const slackAuditLogRepository = new SlackAuditLogRepository();
