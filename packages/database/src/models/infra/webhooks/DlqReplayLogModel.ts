import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IDlqReplayLog {
  id: string;
  queueLabel: string;
  messageId: string;
  messageBody: string;
  sourceQueue: string;
  status: 'success' | 'failed' | 'skipped' | 'discarded' | 'pending';
  operation?: 'replay' | 'discard';
  errorMessage?: string;
  reason?: string;
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
      enum: ['success', 'failed', 'skipped', 'discarded', 'pending'],
      required: true,
    },
    operation: { type: String, enum: ['replay', 'discard'] },
    errorMessage: { type: String },
    reason: { type: String },
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

interface DlqReplayLogFilters {
  queueLabel?: string;
  status?: IDlqReplayLog['status'];
  startDate?: Date;
  endDate?: Date;
  search?: string;
  limit?: number;
  /** Defaults to true. Pass false to project `messageBody` out of the query. */
  includeBody?: boolean;
}

class DlqReplayLogRepository extends BaseRepository<IDlqReplayLog> {
  constructor(private dlqReplayLogModel: mongoose.Model<IDlqReplayLog>) {
    super(dlqReplayLogModel);
    this.model = dlqReplayLogModel;
  }

  /**
   * Count all replay attempts (successful and failed) for a given SQS message ID.
   * Skipped attempts and discard operations are excluded. Enforces the replay attempt limit.
   */
  async countAttempts(messageId: string): Promise<number> {
    return this.model.countDocuments({
      messageId,
      status: { $in: ['success', 'failed'] },
      // Missing operation identifies legacy replay rows and must continue to count.
      operation: { $ne: 'discard' },
    });
  }

  /**
   * Log a replay operation.
   */
  async logReplay(data: Omit<IDlqReplayLog, 'id' | 'createdAt' | 'updatedAt'>): Promise<IDlqReplayLog> {
    const result = await this.model.create(data);
    return result.toObject();
  }

  /** Finalize only the pending discard created before the SQS deletion request. */
  async finalizeDiscard(id: string, status: 'discarded' | 'failed', errorMessage?: string): Promise<void> {
    const result = await this.model.updateOne(
      { _id: id, operation: 'discard', status: 'pending' },
      { $set: { status, ...(errorMessage !== undefined ? { errorMessage } : {}) } }
    );
    if (!result.acknowledged || result.matchedCount !== 1) {
      throw new Error('Discard history could not be finalized from a pending attempt');
    }
  }

  /**
   * Get recent replay history with optional filters.
   */
  async findRecent(
    filters: DlqReplayLogFilters & { includeBody: false }
  ): Promise<Omit<IDlqReplayLog, 'messageBody'>[]>;
  async findRecent(filters?: DlqReplayLogFilters): Promise<IDlqReplayLog[]>;
  async findRecent(filters: DlqReplayLogFilters = {}): Promise<Omit<IDlqReplayLog, 'messageBody'>[]> {
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
        { messageId: { $regex: escaped, $options: 'i' } },
        { errorMessage: { $regex: escaped, $options: 'i' } },
        { reason: { $regex: escaped, $options: 'i' } },
      ];
    }
    const projection = filters.includeBody === false ? { messageBody: 0 } : undefined;
    const results = await this.model
      .find(query, projection)
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
