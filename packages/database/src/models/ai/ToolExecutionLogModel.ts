import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model, Schema, Types } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IToolExecutionLogDocument extends IMongoDocument {
  userId: string;
  toolName: string;
  timestamp: Date;
  success: boolean;
  executionTimeMs: number;
  error?: string;
  errorType?: string; // Error category for analytics
  createdAt: Date;
  updatedAt: Date;
}

interface IToolExecutionLogMethods {
}

interface IToolExecutionLogModel extends Model<IToolExecutionLogDocument, {}, IToolExecutionLogMethods> {}

const ToolExecutionLogSchema = new Schema<IToolExecutionLogDocument, IToolExecutionLogModel, IToolExecutionLogMethods>(
  {
    userId: { type: String, required: true },
    toolName: { type: String, required: true },
    timestamp: { type: Date, required: true },
    success: { type: Boolean, required: true },
    executionTimeMs: { type: Number, required: true },
    error: { type: String },
    errorType: { type: String }, // Error category for analytics (e.g., 'INVALID_INPUT', 'API_KEY_MISSING')
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient user-specific queries (most common use case)
ToolExecutionLogSchema.index({ userId: 1, timestamp: -1 });

// TTL index: auto-delete logs after 90 days
ToolExecutionLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7776000 });

export const ToolExecutionLog =
  (mongoose.models.ToolExecutionLog as IToolExecutionLogModel) ??
  mongoose.model<IToolExecutionLogDocument, IToolExecutionLogModel>('ToolExecutionLog', ToolExecutionLogSchema);

export interface IToolExecutionLogRepository {
  create(data: Omit<IToolExecutionLogDocument, 'id' | 'createdAt' | 'updatedAt'>): Promise<IToolExecutionLogDocument>;
  findByUserId(userId: string, limit?: number): Promise<IToolExecutionLogDocument[]>;
  findByToolName(toolName: string, limit?: number): Promise<IToolExecutionLogDocument[]>;
}

class ToolExecutionLogRepository
  extends BaseRepository<IToolExecutionLogDocument>
  implements IToolExecutionLogRepository
{
  constructor(model: IToolExecutionLogModel) {
    super(model);
  }

  async findByUserId(userId: string, limit: number = 100) {
    return this.model
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
  }

  async findByToolName(toolName: string, limit: number = 100) {
    return this.model.find({ toolName }).sort({ timestamp: -1 }).limit(limit).lean();
  }
}

export const toolExecutionLogRepository = new ToolExecutionLogRepository(ToolExecutionLog);
