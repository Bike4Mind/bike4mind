import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Actions that can be performed on telemetry data
 */
export type TelemetryAuditAction = 'delete' | 'export' | 'view' | 'consent_toggle';

/**
 * Outcome of the audited operation
 */
export type TelemetryAuditOutcome = 'success' | 'failure';

/**
 * TelemetryAuditLog document interface
 *
 * Tracks admin actions on telemetry data for GDPR compliance.
 * Provides audit trail for data subject access requests (DSAR) and
 * right to erasure (deletion) requests.
 */
export interface ITelemetryAuditLogDocument extends Document {
  id: string;
  /** The action performed */
  action: TelemetryAuditAction;
  /** User who performed the action (admin or end-user for consent toggles) */
  userId: string;
  /** User's email for human-readable audit trails */
  userEmail?: string;
  /** Quest ID whose telemetry was affected */
  questId: string;
  /** Source IP address */
  sourceIp: string;
  /** User agent string */
  userAgent: string;
  /** Outcome of the operation */
  outcome: TelemetryAuditOutcome;
  /** Error message if outcome is failure */
  errorMessage?: string;
  /** Duration of the operation in milliseconds */
  durationMs: number;
  /** Additional metadata */
  metadata: Record<string, unknown>;
  createdAt: Date;
  // Required by IMongoDocument base type; always undefined at runtime (timestamps: { updatedAt: false })
  updatedAt: Date;
}

export interface CreateTelemetryAuditLogInput {
  action: TelemetryAuditAction;
  userId: string;
  userEmail?: string;
  questId: string;
  sourceIp: string;
  userAgent: string;
  outcome: TelemetryAuditOutcome;
  errorMessage?: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface ITelemetryAuditLogRepository {
  createLog(data: CreateTelemetryAuditLogInput): Promise<ITelemetryAuditLogDocument>;
  findByDateRange(
    startDate: Date,
    endDate: Date,
    filters?: {
      action?: TelemetryAuditAction;
      outcome?: TelemetryAuditOutcome;
      userId?: string;
      questId?: string;
    },
    limit?: number
  ): Promise<ITelemetryAuditLogDocument[]>;
  findByUser(userId: string, limit?: number): Promise<ITelemetryAuditLogDocument[]>;
  findByQuest(questId: string): Promise<ITelemetryAuditLogDocument[]>;
  getAuditSummary(startDate: Date, endDate: Date): Promise<{ action: string; outcome: string; count: number }[]>;
}

const TelemetryAuditLogSchema = new Schema<ITelemetryAuditLogDocument>(
  {
    action: {
      type: String,
      required: true,
      enum: ['delete', 'export', 'view', 'consent_toggle'],
    },
    userId: { type: String, required: true },
    userEmail: { type: String },
    questId: { type: String, required: true },
    sourceIp: { type: String, required: true },
    userAgent: { type: String, required: true },
    outcome: {
      type: String,
      required: true,
      enum: ['success', 'failure'],
    },
    errorMessage: { type: String },
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

// Indexes for GDPR compliance queries.
// Standalone { createdAt: -1 } removed: the TTL index on { createdAt: 1 } is
// traversable in either direction, and the compound index below covers sorted queries.
TelemetryAuditLogSchema.index({ action: 1, createdAt: -1 });
TelemetryAuditLogSchema.index({ outcome: 1 });
TelemetryAuditLogSchema.index({ userId: 1, createdAt: -1 });
TelemetryAuditLogSchema.index({ questId: 1 });

// TTL index to auto-delete old audit logs after 365 days.
// Audit logs are compliance evidence: SOC 2 requires 12-month retention minimum,
// and CCPA has a 12-month lookback for consumer request history.
// DEPLOY NOTE: MongoDB doesn't auto-update expireAfterSeconds on existing TTL indexes.
// After deploying, run: db.runCommand({ collMod: "telemetryauditlogs", index: { keyPattern: { createdAt: 1 }, expireAfterSeconds: 31536000 } })
TelemetryAuditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 365 * 24 * 60 * 60 } // 365 days
);

class TelemetryAuditLogRepository
  extends BaseRepository<ITelemetryAuditLogDocument>
  implements ITelemetryAuditLogRepository
{
  constructor() {
    super(TelemetryAuditLogModel);
  }

  async createLog(data: CreateTelemetryAuditLogInput): Promise<ITelemetryAuditLogDocument> {
    const result = await this.model.create(data);
    return result.toJSON() as unknown as ITelemetryAuditLogDocument;
  }

  async findByDateRange(
    startDate: Date,
    endDate: Date,
    filters: {
      action?: TelemetryAuditAction;
      outcome?: TelemetryAuditOutcome;
      userId?: string;
      questId?: string;
    } = {},
    limit = 100
  ): Promise<ITelemetryAuditLogDocument[]> {
    const query: Record<string, unknown> = {
      createdAt: { $gte: startDate, $lte: endDate },
    };

    if (filters.action) query.action = filters.action;
    if (filters.outcome) query.outcome = filters.outcome;
    if (filters.userId) query.userId = filters.userId;
    if (filters.questId) query.questId = filters.questId;

    return this.model.find(query).sort({ createdAt: -1 }).limit(limit);
  }

  async findByUser(userId: string, limit = 50): Promise<ITelemetryAuditLogDocument[]> {
    return this.model.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  }

  async findByQuest(questId: string): Promise<ITelemetryAuditLogDocument[]> {
    return this.model.find({ questId }).sort({ createdAt: -1 });
  }

  async getAuditSummary(startDate: Date, endDate: Date): Promise<{ action: string; outcome: string; count: number }[]> {
    return this.model.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: { action: '$action', outcome: '$outcome' },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          action: '$_id.action',
          outcome: '$_id.outcome',
          count: 1,
        },
      },
      { $sort: { count: -1 } },
    ]);
  }
}

export const TelemetryAuditLogModel: Model<ITelemetryAuditLogDocument> =
  (mongoose.models.TelemetryAuditLog as unknown as Model<ITelemetryAuditLogDocument>) ??
  model<ITelemetryAuditLogDocument>('TelemetryAuditLog', TelemetryAuditLogSchema);

export const telemetryAuditLogRepository = new TelemetryAuditLogRepository();
