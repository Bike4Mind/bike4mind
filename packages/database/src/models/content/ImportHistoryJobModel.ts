import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { softDeletePlugin } from '../../utils/mongo';

export interface IImportHistoryJob {
  id: string;
  userId: string;
  source: 'OpenAI' | 'Claude' | 'Notebook';

  // S3 file information
  s3Bucket: string;
  s3Key: string;
  fileSize: number;

  // Status tracking
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number; // 0-100
  currentStep: string;

  // Statistics
  totalItems: number;
  processedItems: number;
  skippedItems: number;
  failedItems: number;

  // Error handling
  errorMessage?: string;
  errorStack?: string;
  failedAt?: Date;

  // Timing
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;

  // Options (for notebook imports)
  importOptions?: {
    conflictResolution?: string;
    preserveIds?: boolean;
    importKnowledge?: boolean;
    importArtifacts?: boolean;
    importTools?: boolean;
    importAgents?: boolean;
    namePrefix?: string;
  };
}

const ImportHistoryJobSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    source: { type: String, enum: ['OpenAI', 'Claude', 'Notebook'], required: true },

    // S3 file information
    s3Bucket: { type: String, required: true },
    s3Key: { type: String, required: true },
    fileSize: { type: Number, required: true },

    // Status tracking
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
      required: true,
      default: 'pending',
    },
    progress: { type: Number, default: 0 },
    currentStep: { type: String, default: 'Initializing...' },

    // Statistics
    totalItems: { type: Number, default: 0 },
    processedItems: { type: Number, default: 0 },
    skippedItems: { type: Number, default: 0 },
    failedItems: { type: Number, default: 0 },

    // Error handling
    errorMessage: { type: String },
    errorStack: { type: String },
    failedAt: { type: Date },

    // Timing
    startedAt: { type: Date },
    completedAt: { type: Date },

    // Options
    importOptions: {
      type: {
        conflictResolution: { type: String },
        preserveIds: { type: Boolean },
        importKnowledge: { type: Boolean },
        importArtifacts: { type: Boolean },
        importTools: { type: Boolean },
        importAgents: { type: Boolean },
        namePrefix: { type: String },
      },
      required: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

ImportHistoryJobSchema.plugin(softDeletePlugin);

// Indexes for performance
ImportHistoryJobSchema.index({ userId: 1, createdAt: -1 }); // List user's imports
ImportHistoryJobSchema.index({ status: 1, createdAt: 1 }); // Find pending/failed jobs
ImportHistoryJobSchema.index({ s3Key: 1 }); // Idempotency check
ImportHistoryJobSchema.index({ userId: 1, status: 1 }); // Active imports check

// TTL index for 7-day auto-cleanup
ImportHistoryJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 }); // 7 days = 604800 seconds

class ImportHistoryJobRepository extends BaseRepository<IImportHistoryJob> {
  constructor(private importHistoryJobModel: mongoose.Model<IImportHistoryJob>) {
    super(importHistoryJobModel);
    this.model = importHistoryJobModel;
  }

  async findById(id: string): Promise<IImportHistoryJob | null> {
    const result = await this.model.findById(id);
    return result?.toObject() ?? null;
  }

  async findByIdAndUserId(id: string, userId: string): Promise<IImportHistoryJob | null> {
    const result = await this.model.findOne({ _id: id, userId });
    return result?.toObject() ?? null;
  }

  async findAllByUserId(userId: string): Promise<IImportHistoryJob[]> {
    const result = await this.model.find({ userId }).sort({ createdAt: -1 });
    return result.map(doc => doc.toJSON());
  }

  async findByS3Key(s3Key: string): Promise<IImportHistoryJob | null> {
    const result = await this.model.findOne({ s3Key });
    return result?.toObject() ?? null;
  }

  async search(
    search: string,
    filters: {
      userId?: string;
      status?: string;
      source?: string;
    },
    pagination: {
      page: number;
      limit: number;
    },
    orderBy: {
      by: string;
      direction: string;
    }
  ) {
    const queryConditions: Record<string, unknown> = {};

    if (filters.userId) {
      queryConditions.userId = filters.userId;
    }

    if (filters.status) {
      queryConditions.status = filters.status;
    }

    if (filters.source) {
      queryConditions.source = filters.source;
    }

    if (search) {
      queryConditions.$or = [
        { currentStep: { $regex: escapeRegex(search), $options: 'si' } },
        { errorMessage: { $regex: escapeRegex(search), $options: 'si' } },
      ];
    }

    const total = await this.model.countDocuments(queryConditions);

    const query = this.model.find(queryConditions);

    query.skip((pagination.page - 1) * pagination.limit).limit(pagination.limit + 1);

    query.sort({ [orderBy.by]: orderBy.direction === 'asc' ? 1 : -1 });

    const result = await query.exec();

    const hasMore = result.length === pagination.limit + 1;
    if (hasMore) result.pop();

    return {
      data: result.map(doc => doc.toJSON()),
      hasMore,
      total,
    };
  }

  async updateProgress(id: string, progress: number, step: string): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          progress,
          currentStep: step,
          status: 'processing',
          updatedAt: new Date(),
        },
      }
    );
  }

  async markComplete(id: string, stats: { processedItems: number; skippedItems: number }): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'completed',
          progress: 100,
          currentStep: 'Import completed successfully',
          processedItems: stats.processedItems,
          skippedItems: stats.skippedItems,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );
  }

  async markFailed(id: string, error: { message: string; stack?: string }): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'failed',
          errorMessage: error.message,
          errorStack: error.stack,
          failedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );
  }

  /**
   * Check if user has any active imports (pending or processing)
   */
  async hasActiveImport(userId: string): Promise<boolean> {
    const count = await this.model.countDocuments({
      userId,
      status: { $in: ['pending', 'processing'] },
    });
    return count > 0;
  }

  async findActiveImportByUserId(userId: string): Promise<IImportHistoryJob | null> {
    const result = await this.model.findOne({
      userId,
      status: { $in: ['pending', 'processing'] },
    });
    return result?.toObject() ?? null;
  }
}

const ImportHistoryJobModel =
  (mongoose.models['ImportHistoryJob'] as unknown as mongoose.Model<IImportHistoryJob>) ||
  mongoose.model<IImportHistoryJob>('ImportHistoryJob', ImportHistoryJobSchema);

export const importHistoryJobRepository = new ImportHistoryJobRepository(ImportHistoryJobModel);

export default ImportHistoryJobModel;
