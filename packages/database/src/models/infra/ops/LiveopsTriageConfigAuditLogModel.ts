import mongoose, { Model, model, Schema, Types } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/**
 * Audit action types
 */
export type LiveopsTriageConfigAuditAction = 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'trigger';

/**
 * Field change record
 */
export interface ILiveopsTriageConfigFieldChange {
  old: unknown;
  new: unknown;
}

/**
 * LiveOps Triage Config Audit Log Document
 * Tracks all configuration changes for SOC2 compliance
 */
export interface ILiveopsTriageConfigAuditLogDocument extends IMongoDocument {
  configId: Types.ObjectId;
  configName: string;
  action: LiveopsTriageConfigAuditAction;
  userId: string;
  userName: string;
  changes?: Record<string, ILiveopsTriageConfigFieldChange>;
  timestamp: Date;
}

/**
 * Input for creating an audit log entry
 */
export interface CreateLiveopsTriageConfigAuditLogInput {
  configId: Types.ObjectId | string;
  configName: string;
  action: LiveopsTriageConfigAuditAction;
  userId: string;
  userName: string;
  changes?: Record<string, ILiveopsTriageConfigFieldChange>;
}

/**
 * Repository interface
 */
export interface ILiveopsTriageConfigAuditLogRepository {
  createLog(data: CreateLiveopsTriageConfigAuditLogInput): Promise<ILiveopsTriageConfigAuditLogDocument>;
  findByConfigId(configId: string, limit?: number): Promise<ILiveopsTriageConfigAuditLogDocument[]>;
  findByUserId(userId: string, limit?: number): Promise<ILiveopsTriageConfigAuditLogDocument[]>;
  findByDateRange(
    startDate: Date,
    endDate: Date,
    filters?: {
      configId?: string;
      userId?: string;
      action?: LiveopsTriageConfigAuditAction;
    },
    limit?: number
  ): Promise<ILiveopsTriageConfigAuditLogDocument[]>;
  findRecent(limit?: number): Promise<ILiveopsTriageConfigAuditLogDocument[]>;
}

const LiveopsTriageConfigAuditLogSchema = new Schema<ILiveopsTriageConfigAuditLogDocument>(
  {
    configId: { type: Schema.Types.ObjectId, required: true, ref: 'LiveopsTriageConfig', index: true },
    configName: { type: String, required: true },
    action: {
      type: String,
      required: true,
      enum: ['create', 'update', 'delete', 'enable', 'disable', 'trigger'],
    },
    userId: { type: String, required: true, index: true },
    userName: { type: String, required: true },
    changes: { type: Map, of: Schema.Types.Mixed },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  {
    toJSON: {
      virtuals: true,
      transform: function (_doc, ret) {
        if (ret.changes instanceof Map) {
          ret.changes = Object.fromEntries(ret.changes);
        }
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: function (_doc, ret) {
        if (ret.changes instanceof Map) {
          ret.changes = Object.fromEntries(ret.changes);
        }
        return ret;
      },
    },
    versionKey: false,
  }
);

// Indexes for SOC2 compliance queries
LiveopsTriageConfigAuditLogSchema.index({ timestamp: -1 });
LiveopsTriageConfigAuditLogSchema.index({ configId: 1, timestamp: -1 });
LiveopsTriageConfigAuditLogSchema.index({ userId: 1, timestamp: -1 });
LiveopsTriageConfigAuditLogSchema.index({ action: 1, timestamp: -1 });

// TTL index to auto-delete old audit logs after 90 days (consistent with other audit logs)
LiveopsTriageConfigAuditLogSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 } // 90 days
);

class LiveopsTriageConfigAuditLogRepository
  extends BaseRepository<ILiveopsTriageConfigAuditLogDocument>
  implements ILiveopsTriageConfigAuditLogRepository
{
  constructor() {
    super(LiveopsTriageConfigAuditLogModel);
  }

  async createLog(data: CreateLiveopsTriageConfigAuditLogInput): Promise<ILiveopsTriageConfigAuditLogDocument> {
    const result = await this.model.create({
      ...data,
      timestamp: new Date(),
    });
    return result.toJSON() as ILiveopsTriageConfigAuditLogDocument;
  }

  async findByConfigId(configId: string, limit = 50): Promise<ILiveopsTriageConfigAuditLogDocument[]> {
    const results = await this.model.find({ configId }).sort({ timestamp: -1 }).limit(limit);
    return results.map(doc => doc.toJSON() as ILiveopsTriageConfigAuditLogDocument);
  }

  async findByUserId(userId: string, limit = 50): Promise<ILiveopsTriageConfigAuditLogDocument[]> {
    const results = await this.model.find({ userId }).sort({ timestamp: -1 }).limit(limit);
    return results.map(doc => doc.toJSON() as ILiveopsTriageConfigAuditLogDocument);
  }

  async findByDateRange(
    startDate: Date,
    endDate: Date,
    filters: {
      configId?: string;
      userId?: string;
      action?: LiveopsTriageConfigAuditAction;
    } = {},
    limit = 100
  ): Promise<ILiveopsTriageConfigAuditLogDocument[]> {
    const query: Record<string, unknown> = {
      timestamp: { $gte: startDate, $lte: endDate },
    };

    if (filters.configId) query.configId = filters.configId;
    if (filters.userId) query.userId = filters.userId;
    if (filters.action) query.action = filters.action;

    const results = await this.model.find(query).sort({ timestamp: -1 }).limit(limit);
    return results.map(doc => doc.toJSON() as ILiveopsTriageConfigAuditLogDocument);
  }

  async findRecent(limit = 20): Promise<ILiveopsTriageConfigAuditLogDocument[]> {
    const results = await this.model.find().sort({ timestamp: -1 }).limit(limit);
    return results.map(doc => doc.toJSON() as ILiveopsTriageConfigAuditLogDocument);
  }
}

export const LiveopsTriageConfigAuditLogModel: Model<ILiveopsTriageConfigAuditLogDocument> =
  (mongoose.models.LiveopsTriageConfigAuditLog as unknown as Model<ILiveopsTriageConfigAuditLogDocument>) ??
  model<ILiveopsTriageConfigAuditLogDocument>('LiveopsTriageConfigAuditLog', LiveopsTriageConfigAuditLogSchema);

export const liveopsTriageConfigAuditLogRepository = new LiveopsTriageConfigAuditLogRepository();
