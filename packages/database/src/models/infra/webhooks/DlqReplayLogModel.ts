import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IDlqReplayLog {
  id: string;
  queueLabel: string;
  messageId: string;
  messageBody: string;
  sourceQueue: string;
  status: 'success' | 'failed' | 'skipped';
  errorMessage?: string;
  replayedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const DlqReplayLogSchema = new mongoose.Schema(
  {
    queueLabel: { type: String, required: true },
    messageId: { type: String, required: true },
    messageBody: { type: String, required: true },
    // Stores the human-readable display name (e.g., "FabFile Vectorize"), not the queue URL
    sourceQueue: { type: String, required: true },
    status: {
      type: String,
      enum: ['success', 'failed', 'skipped'],
      required: true,
    },
    errorMessage: { type: String },
    replayedBy: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// For history queries sorted by time
DlqReplayLogSchema.index({ queueLabel: 1, createdAt: -1 });

// For counting replay attempts per message
DlqReplayLogSchema.index({ messageId: 1, status: 1 });

// Auto-delete after 30 days
DlqReplayLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

class DlqReplayLogRepository extends BaseRepository<IDlqReplayLog> {
  constructor(private dlqReplayLogModel: mongoose.Model<IDlqReplayLog>) {
    super(dlqReplayLogModel);
    this.model = dlqReplayLogModel;
  }

  /**
   * Count all replay attempts (successful and failed) for a given SQS message ID.
   * Skipped attempts are excluded. Used to enforce the max replay attempt limit.
   */
  async countAttempts(messageId: string): Promise<number> {
    return this.model.countDocuments({ messageId, status: { $in: ['success', 'failed'] } });
  }

  /**
   * Log a replay operation.
   */
  async logReplay(data: Omit<IDlqReplayLog, 'id' | 'createdAt' | 'updatedAt'>): Promise<IDlqReplayLog> {
    const result = await this.model.create(data);
    return result.toObject();
  }

  /**
   * Get recent replay history with optional filters.
   */
  async findRecent(
    filters: {
      queueLabel?: string;
      status?: 'success' | 'failed' | 'skipped';
      startDate?: Date;
      endDate?: Date;
      search?: string;
      limit?: number;
    } = {}
  ): Promise<IDlqReplayLog[]> {
    const query: Record<string, unknown> = {};
    if (filters.queueLabel) query.queueLabel = filters.queueLabel;
    if (filters.status) query.status = filters.status;
    if (filters.startDate || filters.endDate) {
      query.createdAt = {};
      if (filters.startDate) (query.createdAt as Record<string, Date>).$gte = filters.startDate;
      if (filters.endDate) (query.createdAt as Record<string, Date>).$lte = filters.endDate;
    }
    if (filters.search) {
      const escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { messageBody: { $regex: escaped, $options: 'i' } },
        { errorMessage: { $regex: escaped, $options: 'i' } },
      ];
    }
    const results = await this.model
      .find(query)
      .sort({ createdAt: -1 })
      .limit(filters.limit ?? 50);
    return results.map(doc => doc.toObject());
  }
}

const DlqReplayLogModel =
  (mongoose.models['DlqReplayLog'] as unknown as mongoose.Model<IDlqReplayLog>) ||
  mongoose.model<IDlqReplayLog>('DlqReplayLog', DlqReplayLogSchema);

export const dlqReplayLogRepository = new DlqReplayLogRepository(DlqReplayLogModel);

export default DlqReplayLogModel;
