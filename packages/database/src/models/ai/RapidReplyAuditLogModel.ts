import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IRapidReplyAuditLogDocument extends Document {
  id: string;
  entityType: 'mapping' | 'prompt' | 'settings' | 'result';
  entityId: string;
  action: 'create' | 'update' | 'delete' | 'activate' | 'deactivate' | 'bulk_update';
  changes: Record<string, { before?: any; after?: any }>; // Field-level changes
  userId: string;
  userEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>; // Additional context
  createdAt: Date;
  updatedAt: Date;
}

export interface IRapidReplyAuditLogRepository {
  findAll(limit?: number): Promise<IRapidReplyAuditLogDocument[]>;
  findByEntity(entityType: string, entityId: string, limit?: number): Promise<IRapidReplyAuditLogDocument[]>;
  findByUser(userId: string, limit?: number): Promise<IRapidReplyAuditLogDocument[]>;
  findByDateRange(startDate: Date, endDate: Date, limit?: number): Promise<IRapidReplyAuditLogDocument[]>;
  createLog(data: Partial<IRapidReplyAuditLogDocument>): Promise<IRapidReplyAuditLogDocument>;
  cleanupOldLogs(olderThanDays: number): Promise<number>;
  getAuditSummary(filters?: { startDate?: Date; endDate?: Date; entityType?: string; userId?: string }): Promise<{
    totalActions: number;
    actionBreakdown: Record<string, number>;
    entityBreakdown: Record<string, number>;
    userBreakdown: Record<string, { count: number; email?: string }>;
    recentActivity: IRapidReplyAuditLogDocument[];
  }>;
}

const RapidReplyAuditLogSchema = new Schema<IRapidReplyAuditLogDocument>(
  {
    entityType: {
      type: String,
      required: true,
      enum: ['mapping', 'prompt', 'settings', 'result'],
    },
    entityId: { type: String, required: true },
    action: {
      type: String,
      required: true,
      enum: ['create', 'update', 'delete', 'activate', 'deactivate', 'bulk_update'],
    },
    changes: { type: Map, of: Schema.Types.Mixed, default: {} },
    userId: { type: String, required: true },
    userEmail: { type: String },
    ipAddress: { type: String },
    userAgent: { type: String },
    metadata: { type: Map, of: Schema.Types.Mixed, default: {} },
  },
  {
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        // Convert Maps to plain objects for JSON serialization
        if (ret.changes instanceof Map) {
          ret.changes = Object.fromEntries(ret.changes);
        }
        if (ret.metadata instanceof Map) {
          ret.metadata = Object.fromEntries(ret.metadata);
        }
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: function (doc, ret) {
        // Convert Maps to plain objects
        if (ret.changes instanceof Map) {
          ret.changes = Object.fromEntries(ret.changes);
        }
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

// Indexes for performance
RapidReplyAuditLogSchema.index({ entityType: 1, entityId: 1 });
RapidReplyAuditLogSchema.index({ userId: 1 });
RapidReplyAuditLogSchema.index({ createdAt: -1 });
RapidReplyAuditLogSchema.index({ action: 1 });

// TTL index to auto-delete old audit logs after 90 days
RapidReplyAuditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 } // 90 days
);

class RapidReplyAuditLogRepository
  extends BaseRepository<IRapidReplyAuditLogDocument>
  implements IRapidReplyAuditLogRepository
{
  constructor() {
    super(RapidReplyAuditLogModel);
  }

  async findAll(limit = 100): Promise<IRapidReplyAuditLogDocument[]> {
    return this.model.find({}).sort({ createdAt: -1 }).limit(limit);
  }

  async findByEntity(entityType: string, entityId: string, limit = 50): Promise<IRapidReplyAuditLogDocument[]> {
    return this.model.find({ entityType, entityId }).sort({ createdAt: -1 }).limit(limit);
  }

  async findByUser(userId: string, limit = 50): Promise<IRapidReplyAuditLogDocument[]> {
    return this.model.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  }

  async findByDateRange(startDate: Date, endDate: Date, limit = 100): Promise<IRapidReplyAuditLogDocument[]> {
    return this.model
      .find({
        createdAt: {
          $gte: startDate,
          $lte: endDate,
        },
      })
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  async createLog(data: Partial<IRapidReplyAuditLogDocument>): Promise<IRapidReplyAuditLogDocument> {
    const result = await this.model.create(data);
    return result.toJSON() as unknown as IRapidReplyAuditLogDocument;
  }

  async cleanupOldLogs(olderThanDays: number): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.model.deleteMany({ createdAt: { $lt: cutoffDate } });
    return result.deletedCount || 0;
  }

  async getAuditSummary(
    filters: {
      startDate?: Date;
      endDate?: Date;
      entityType?: string;
      userId?: string;
    } = {}
  ): Promise<{
    totalActions: number;
    actionBreakdown: Record<string, number>;
    entityBreakdown: Record<string, number>;
    userBreakdown: Record<string, { count: number; email?: string }>;
    recentActivity: IRapidReplyAuditLogDocument[];
  }> {
    const matchConditions: any = {};

    if (filters.startDate || filters.endDate) {
      matchConditions.createdAt = {};
      if (filters.startDate) matchConditions.createdAt.$gte = filters.startDate;
      if (filters.endDate) matchConditions.createdAt.$lte = filters.endDate;
    }

    if (filters.entityType) matchConditions.entityType = filters.entityType;
    if (filters.userId) matchConditions.userId = filters.userId;

    const [totalStats, actionStats, entityStats, userStats, recentActivity] = await Promise.all([
      // Total count
      this.model.countDocuments(matchConditions),

      // Action breakdown
      this.model.aggregate([{ $match: matchConditions }, { $group: { _id: '$action', count: { $sum: 1 } } }]),

      // Entity type breakdown
      this.model.aggregate([{ $match: matchConditions }, { $group: { _id: '$entityType', count: { $sum: 1 } } }]),

      // User breakdown
      this.model.aggregate([
        { $match: matchConditions },
        {
          $group: {
            _id: { userId: '$userId', email: '$userEmail' },
            count: { $sum: 1 },
          },
        },
      ]),

      // Recent activity
      this.model.find(matchConditions).sort({ createdAt: -1 }).limit(10),
    ]);

    return {
      totalActions: totalStats,
      actionBreakdown: actionStats.reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        {} as Record<string, number>
      ),
      entityBreakdown: entityStats.reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        {} as Record<string, number>
      ),
      userBreakdown: userStats.reduce(
        (acc, item) => {
          acc[item._id.userId] = {
            count: item.count,
            email: item._id.email,
          };
          return acc;
        },
        {} as Record<string, { count: number; email?: string }>
      ),
      recentActivity: recentActivity.map(log => log.toJSON()) as unknown as IRapidReplyAuditLogDocument[],
    };
  }
}

export const RapidReplyAuditLogModel: Model<IRapidReplyAuditLogDocument> =
  (mongoose.models.RapidReplyAuditLog as unknown as Model<IRapidReplyAuditLogDocument>) ??
  model<IRapidReplyAuditLogDocument>('RapidReplyAuditLog', RapidReplyAuditLogSchema);

export const rapidReplyAuditLogRepository = new RapidReplyAuditLogRepository();
