import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { softDeletePlugin } from '../../../utils/mongo';

export interface ISlackExportJob {
  id: string;
  userId: string;

  // Slack workspace and channel info
  workspaceId: string;
  channelId: string;
  channelName?: string;

  // Export options
  format: 'json' | 'csv' | 'markdown';
  includeThreads: boolean;
  includeUserNames: boolean;
  dateRange?: {
    start?: string;
    end?: string;
  };

  // S3 file information (populated on completion)
  s3Bucket?: string;
  s3Key?: string;
  fileSize?: number;

  // Status tracking
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number; // 0-100
  currentStep: string;

  // Statistics
  totalMessages: number;
  processedMessages: number;
  threadsFetched: number;
  threadRepliesFetched: number;
  usersResolved: number;

  // Error handling
  errorMessage?: string;
  errorStack?: string;
  failedAt?: Date;

  // Timing
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;

  // Download info
  downloadUrl?: string;
  downloadExpiresAt?: Date;
}

const SlackExportJobSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },

    // Slack workspace and channel info
    workspaceId: { type: String, required: true },
    channelId: { type: String, required: true },
    channelName: { type: String },

    // Export options
    format: { type: String, enum: ['json', 'csv', 'markdown'], required: true, default: 'json' },
    includeThreads: { type: Boolean, default: true },
    includeUserNames: { type: Boolean, default: true },
    dateRange: {
      type: {
        start: { type: String },
        end: { type: String },
      },
      required: false,
    },

    // S3 file information
    s3Bucket: { type: String },
    s3Key: { type: String },
    fileSize: { type: Number },

    // Status tracking
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
      required: true,
      default: 'pending',
    },
    progress: { type: Number, default: 0 },
    currentStep: { type: String, default: 'Queued for processing...' },

    // Statistics
    totalMessages: { type: Number, default: 0 },
    processedMessages: { type: Number, default: 0 },
    threadsFetched: { type: Number, default: 0 },
    threadRepliesFetched: { type: Number, default: 0 },
    usersResolved: { type: Number, default: 0 },

    // Error handling
    errorMessage: { type: String },
    errorStack: { type: String },
    failedAt: { type: Date },

    // Timing
    startedAt: { type: Date },
    completedAt: { type: Date },

    // Download info
    downloadUrl: { type: String },
    downloadExpiresAt: { type: Date },
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

// Add soft delete plugin
SlackExportJobSchema.plugin(softDeletePlugin);

// Indexes for performance
SlackExportJobSchema.index({ userId: 1, createdAt: -1 }); // List user's exports
SlackExportJobSchema.index({ status: 1, createdAt: 1 }); // Find pending/failed jobs
SlackExportJobSchema.index({ userId: 1, status: 1 }); // Active exports check
SlackExportJobSchema.index({ workspaceId: 1, channelId: 1 }); // Find exports by channel

// TTL index for 7-day auto-cleanup (exports are temporary)
SlackExportJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 }); // 7 days

class SlackExportJobRepository extends BaseRepository<ISlackExportJob> {
  constructor(private slackExportJobModel: mongoose.Model<ISlackExportJob>) {
    super(slackExportJobModel);
    this.model = slackExportJobModel;
  }

  async findById(id: string): Promise<ISlackExportJob | null> {
    const result = await this.model.findById(id);
    return result?.toObject() ?? null;
  }

  async findByIdAndUserId(id: string, userId: string): Promise<ISlackExportJob | null> {
    const result = await this.model.findOne({ _id: id, userId });
    return result?.toObject() ?? null;
  }

  async findAllByUserId(userId: string, limit = 20): Promise<ISlackExportJob[]> {
    const result = await this.model.find({ userId }).sort({ createdAt: -1 }).limit(limit);
    return result.map(doc => doc.toJSON());
  }

  async findActiveByUserId(userId: string): Promise<ISlackExportJob | null> {
    const result = await this.model.findOne({
      userId,
      status: { $in: ['pending', 'processing'] },
    });
    return result?.toObject() ?? null;
  }

  async hasActiveExport(userId: string): Promise<boolean> {
    const count = await this.model.countDocuments({
      userId,
      status: { $in: ['pending', 'processing'] },
    });
    return count > 0;
  }

  async updateProgress(
    id: string,
    data: {
      progress: number;
      currentStep: string;
      processedMessages?: number;
      totalMessages?: number;
      threadsFetched?: number;
      threadRepliesFetched?: number;
      usersResolved?: number;
    }
  ): Promise<void> {
    const updateData: Record<string, unknown> = {
      progress: data.progress,
      currentStep: data.currentStep,
      status: 'processing',
      updatedAt: new Date(),
    };

    if (data.processedMessages !== undefined) updateData.processedMessages = data.processedMessages;
    if (data.totalMessages !== undefined) updateData.totalMessages = data.totalMessages;
    if (data.threadsFetched !== undefined) updateData.threadsFetched = data.threadsFetched;
    if (data.threadRepliesFetched !== undefined) updateData.threadRepliesFetched = data.threadRepliesFetched;
    if (data.usersResolved !== undefined) updateData.usersResolved = data.usersResolved;

    await this.model.updateOne({ _id: id }, { $set: updateData });
  }

  async markStarted(id: string): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'processing',
          startedAt: new Date(),
          currentStep: 'Starting export...',
          updatedAt: new Date(),
        },
      }
    );
  }

  async markComplete(
    id: string,
    data: {
      s3Bucket: string;
      s3Key: string;
      fileSize: number;
      downloadUrl: string;
      downloadExpiresAt: Date;
      channelName?: string;
      processedMessages: number;
      threadsFetched: number;
      threadRepliesFetched: number;
      usersResolved: number;
    }
  ): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'completed',
          progress: 100,
          currentStep: 'Export completed successfully',
          s3Bucket: data.s3Bucket,
          s3Key: data.s3Key,
          fileSize: data.fileSize,
          downloadUrl: data.downloadUrl,
          downloadExpiresAt: data.downloadExpiresAt,
          channelName: data.channelName,
          processedMessages: data.processedMessages,
          threadsFetched: data.threadsFetched,
          threadRepliesFetched: data.threadRepliesFetched,
          usersResolved: data.usersResolved,
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

  async cancel(id: string, userId: string): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, userId, status: { $in: ['pending', 'processing'] } },
      {
        $set: {
          status: 'cancelled',
          currentStep: 'Export cancelled by user',
          updatedAt: new Date(),
        },
      }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Update download URL (for refreshing expired presigned URLs)
   */
  async updateDownloadUrl(id: string, downloadUrl: string, expiresAt: Date): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          downloadUrl,
          downloadExpiresAt: expiresAt,
          updatedAt: new Date(),
        },
      }
    );
  }
}

const SlackExportJobModel =
  (mongoose.models['SlackExportJob'] as unknown as mongoose.Model<ISlackExportJob>) ||
  mongoose.model<ISlackExportJob>('SlackExportJob', SlackExportJobSchema);

export const slackExportJobRepository = new SlackExportJobRepository(SlackExportJobModel);

export default SlackExportJobModel;
