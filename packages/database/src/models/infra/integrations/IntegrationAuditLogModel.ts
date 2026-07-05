import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Entity types for integration audit logging
 */
export type IntegrationAuditEntityType = 'oauth' | 'webhook' | 'mcp_tool' | 'token_refresh';

/**
 * Supported integration names
 */
export type IntegrationAuditIntegrationName = 'github' | 'atlassian' | 'slack' | 'linear' | 'notion' | 'optihashi';

/**
 * Outcome of the audited operation
 */
export type IntegrationAuditOutcome = 'success' | 'failure' | 'rate_limited';

export interface IIntegrationAuditLogDocument extends Document {
  id: string;
  entityType: IntegrationAuditEntityType;
  integrationName: IntegrationAuditIntegrationName;
  action: string;
  userId?: string;
  workspaceId?: string;
  requestId: string;
  sourceIp: string;
  userAgent: string;
  outcome: IntegrationAuditOutcome;
  errorCode?: string;
  durationMs: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date; // Required by IMongoDocument constraint; not auto-set (timestamps.updatedAt: false)
}

export interface CreateIntegrationAuditLogInput {
  entityType: IntegrationAuditEntityType;
  integrationName: IntegrationAuditIntegrationName;
  action: string;
  userId?: string;
  workspaceId?: string;
  requestId: string;
  sourceIp: string;
  userAgent: string;
  outcome: IntegrationAuditOutcome;
  errorCode?: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface IIntegrationAuditLogRepository {
  createLog(data: CreateIntegrationAuditLogInput): Promise<IIntegrationAuditLogDocument>;
  findByDateRange(
    startDate: Date,
    endDate: Date,
    filters?: {
      entityType?: IntegrationAuditEntityType;
      integrationName?: IntegrationAuditIntegrationName;
      outcome?: IntegrationAuditOutcome;
      userId?: string;
      workspaceId?: string;
    },
    limit?: number
  ): Promise<IIntegrationAuditLogDocument[]>;
  findByUser(userId: string, limit?: number): Promise<IIntegrationAuditLogDocument[]>;
  findByIntegration(
    integrationName: IntegrationAuditIntegrationName,
    limit?: number
  ): Promise<IIntegrationAuditLogDocument[]>;
  cleanupOldLogs(olderThanDays: number): Promise<number>;
}

const IntegrationAuditLogSchema = new Schema<IIntegrationAuditLogDocument>(
  {
    entityType: {
      type: String,
      required: true,
      enum: ['oauth', 'webhook', 'mcp_tool', 'token_refresh'],
    },
    integrationName: {
      type: String,
      required: true,
      enum: ['github', 'atlassian', 'slack', 'linear', 'notion'],
    },
    action: { type: String, required: true },
    userId: { type: String, index: true },
    workspaceId: { type: String },
    requestId: { type: String, required: true },
    sourceIp: { type: String, required: true },
    userAgent: { type: String, required: true },
    outcome: {
      type: String,
      required: true,
      enum: ['success', 'failure', 'rate_limited'],
    },
    errorCode: { type: String },
    durationMs: { type: Number, required: true },
    metadata: { type: Map, of: Schema.Types.Mixed, default: {} },
  },
  {
    toJSON: {
      virtuals: true,
      transform: function (_doc, ret) {
        if (ret.metadata instanceof Map) {
          ret.metadata = Object.fromEntries(ret.metadata);
        }
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: function (_doc, ret) {
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

// Indexes for common SOC 2 compliance queries
IntegrationAuditLogSchema.index({ createdAt: -1 });
IntegrationAuditLogSchema.index({ integrationName: 1, createdAt: -1 });
IntegrationAuditLogSchema.index({ entityType: 1, createdAt: -1 });
IntegrationAuditLogSchema.index({ outcome: 1 });
IntegrationAuditLogSchema.index({ userId: 1, createdAt: -1 });
IntegrationAuditLogSchema.index({ workspaceId: 1, createdAt: -1 });
IntegrationAuditLogSchema.index({ requestId: 1 });

// TTL index to auto-delete old audit logs after 90 days (consistent with other audit logs)
IntegrationAuditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 } // 90 days
);

class IntegrationAuditLogRepository
  extends BaseRepository<IIntegrationAuditLogDocument>
  implements IIntegrationAuditLogRepository
{
  constructor() {
    super(IntegrationAuditLogModel);
  }

  async createLog(data: CreateIntegrationAuditLogInput): Promise<IIntegrationAuditLogDocument> {
    const result = await this.model.create(data);
    return result.toJSON() as unknown as IIntegrationAuditLogDocument;
  }

  async findByDateRange(
    startDate: Date,
    endDate: Date,
    filters: {
      entityType?: IntegrationAuditEntityType;
      integrationName?: IntegrationAuditIntegrationName;
      outcome?: IntegrationAuditOutcome;
      userId?: string;
      workspaceId?: string;
    } = {},
    limit = 100
  ): Promise<IIntegrationAuditLogDocument[]> {
    const query: Record<string, unknown> = {
      createdAt: { $gte: startDate, $lte: endDate },
    };

    if (filters.entityType) query.entityType = filters.entityType;
    if (filters.integrationName) query.integrationName = filters.integrationName;
    if (filters.outcome) query.outcome = filters.outcome;
    if (filters.userId) query.userId = filters.userId;
    if (filters.workspaceId) query.workspaceId = filters.workspaceId;

    return this.model.find(query).sort({ createdAt: -1 }).limit(limit);
  }

  async findByUser(userId: string, limit = 50): Promise<IIntegrationAuditLogDocument[]> {
    return this.model.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  }

  async findByIntegration(
    integrationName: IntegrationAuditIntegrationName,
    limit = 50
  ): Promise<IIntegrationAuditLogDocument[]> {
    return this.model.find({ integrationName }).sort({ createdAt: -1 }).limit(limit);
  }

  async cleanupOldLogs(olderThanDays: number): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.model.deleteMany({ createdAt: { $lt: cutoffDate } });
    return result.deletedCount || 0;
  }
}

export const IntegrationAuditLogModel: Model<IIntegrationAuditLogDocument> =
  (mongoose.models.IntegrationAuditLog as unknown as Model<IIntegrationAuditLogDocument>) ??
  model<IIntegrationAuditLogDocument>('IntegrationAuditLog', IntegrationAuditLogSchema);

export const integrationAuditLogRepository = new IntegrationAuditLogRepository();
