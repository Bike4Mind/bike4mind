import mongoose, { Model, model, Schema, Types } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/**
 * Run type
 */
export type LiveopsTriageRunType = 'dry' | 'full';

/**
 * Run source
 */
export type LiveopsTriageRunSource = 'manual' | 'cron';

/**
 * Run status
 */
export type LiveopsTriageRunStatus = 'queued' | 'processing' | 'complete' | 'failed';

/**
 * Run result (populated on completion)
 */
export interface ILiveopsTriageRunResult {
  errorsProcessed: number;
  issuesCreated: number;
  issuesDeduplicated: number;
}

/**
 * Summary for dry run results
 */
export interface ILiveopsTriageDryRunSummary {
  totalAlerts: number;
  newIssues: number;
  duplicates: number;
  regressions: number;
  p0Count: number;
  p1Count: number;
  p2Count: number;
  p3Count: number;
  recurringPatterns: string[];
  healthAssessment: string;
}

/**
 * Issue that would be created in dry run
 */
export interface ILiveopsTriageDryRunIssueWouldCreate {
  title: string;
  priority: string;
  category: string;
  body: string;
  labels: string[];
  isRecurring: boolean;
  occurrenceCount: number;
  isRegression: boolean;
}

/**
 * Issue that would be skipped in dry run
 */
export interface ILiveopsTriageDryRunIssueWouldSkip {
  title: string;
  priority: string;
  matchesExisting: { issueNumber: number; title: string; state?: 'open' | 'closed' };
}

/**
 * LLM details for dry run
 */
export interface ILiveopsTriageDryRunLLMDetails {
  modelId: string;
  promptLength: number;
  responseLength: number;
  estimatedCost: string;
}

/**
 * Full dry run result (stored for dry runs only)
 */
export interface ILiveopsTriageDryRunResult {
  status: 'success' | 'failed';
  lookbackHours: number;
  alertsFetched: number;
  alertsToProcess: number;
  existingIssuesFound: number;
  summary: ILiveopsTriageDryRunSummary;
  issuesWouldCreate: ILiveopsTriageDryRunIssueWouldCreate[];
  issuesWouldSkip: ILiveopsTriageDryRunIssueWouldSkip[];
  llmDetails: ILiveopsTriageDryRunLLMDetails;
  error?: string;
}

/**
 * LiveOps Triage Run Document
 * Tracks individual triage runs with progress for UI display
 */
export interface ILiveopsTriageRunDocument extends IMongoDocument {
  configId: Types.ObjectId;
  configName: string;
  runType: LiveopsTriageRunType;
  source: LiveopsTriageRunSource;
  status: LiveopsTriageRunStatus;
  progress: number;

  // Timing
  queuedAt: Date;
  startedAt?: Date;
  completedAt?: Date;

  // Results (populated on completion)
  result?: ILiveopsTriageRunResult;
  error?: string;

  // Full dry run result (only for dry runs)
  dryRunResult?: ILiveopsTriageDryRunResult;

  // TTL - auto-delete after 24 hours
  expiresAt: Date;
}

/**
 * Input for creating a new run
 */
export interface CreateLiveopsTriageRunInput {
  configId: Types.ObjectId | string;
  configName: string;
  runType: LiveopsTriageRunType;
  source: LiveopsTriageRunSource;
}

/**
 * Repository interface
 */
export interface ILiveopsTriageRunRepository {
  findById(id: string): Promise<ILiveopsTriageRunDocument | null>;
  findActiveRuns(): Promise<ILiveopsTriageRunDocument[]>;
  findRecentRuns(minutes?: number): Promise<ILiveopsTriageRunDocument[]>;
  findByConfigId(configId: string): Promise<ILiveopsTriageRunDocument[]>;
  createRun(data: CreateLiveopsTriageRunInput): Promise<ILiveopsTriageRunDocument>;
  updateProgress(id: string, progress: number): Promise<void>;
  markStarted(id: string): Promise<void>;
  markComplete(id: string, result: ILiveopsTriageRunResult, dryRunResult?: ILiveopsTriageDryRunResult): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  hasActiveRunForConfig(configId: string): Promise<boolean>;
}

const LiveopsTriageRunSchema = new Schema<ILiveopsTriageRunDocument>(
  {
    configId: { type: Schema.Types.ObjectId, required: true, ref: 'LiveopsTriageConfig', index: true },
    configName: { type: String, required: true },
    runType: {
      type: String,
      required: true,
      enum: ['dry', 'full'],
    },
    source: {
      type: String,
      required: true,
      enum: ['manual', 'cron'],
    },
    status: {
      type: String,
      required: true,
      enum: ['queued', 'processing', 'complete', 'failed'],
      default: 'queued',
    },
    progress: { type: Number, default: 0, min: 0, max: 100 },

    // Timing
    queuedAt: { type: Date, required: true, default: Date.now },
    startedAt: { type: Date },
    completedAt: { type: Date },

    // Results
    result: {
      type: {
        errorsProcessed: { type: Number },
        issuesCreated: { type: Number },
        issuesDeduplicated: { type: Number },
      },
      required: false,
    },
    error: { type: String },

    // Full dry run result (only populated for dry runs)
    dryRunResult: {
      type: Schema.Types.Mixed,
      required: false,
    },

    // TTL - auto-delete after 24 hours
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
LiveopsTriageRunSchema.index({ status: 1, queuedAt: -1 });
LiveopsTriageRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
LiveopsTriageRunSchema.index({ configId: 1, status: 1 });

class LiveopsTriageRunRepository
  extends BaseRepository<ILiveopsTriageRunDocument>
  implements ILiveopsTriageRunRepository
{
  constructor() {
    super(LiveopsTriageRunModel);
  }

  async findById(id: string): Promise<ILiveopsTriageRunDocument | null> {
    const result = await this.model.findById(id);
    return result?.toObject() ?? null;
  }

  async findActiveRuns(): Promise<ILiveopsTriageRunDocument[]> {
    const results = await this.model.find({ status: { $in: ['queued', 'processing'] } }).sort({ queuedAt: -1 });
    return results.map(doc => doc.toObject());
  }

  async findRecentRuns(minutes = 10): Promise<ILiveopsTriageRunDocument[]> {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    const results = await this.model
      .find({
        $or: [{ status: { $in: ['queued', 'processing'] } }, { completedAt: { $gte: cutoff } }],
      })
      .sort({ queuedAt: -1 });
    return results.map(doc => doc.toObject());
  }

  async findByConfigId(configId: string): Promise<ILiveopsTriageRunDocument[]> {
    const results = await this.model.find({ configId }).sort({ queuedAt: -1 }).limit(10);
    return results.map(doc => doc.toObject());
  }

  async createRun(data: CreateLiveopsTriageRunInput): Promise<ILiveopsTriageRunDocument> {
    const result = await this.model.create({
      ...data,
      status: 'queued',
      progress: 0,
      queuedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return result.toObject();
  }

  async updateProgress(id: string, progress: number): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { progress: Math.min(Math.max(progress, 0), 100) } });
  }

  async markStarted(id: string): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'processing',
          startedAt: new Date(),
          progress: 5,
        },
      }
    );
  }

  async markComplete(
    id: string,
    result: ILiveopsTriageRunResult,
    dryRunResult?: ILiveopsTriageDryRunResult
  ): Promise<void> {
    const updateFields: Record<string, unknown> = {
      status: 'complete',
      progress: 100,
      completedAt: new Date(),
      result,
    };

    if (dryRunResult) {
      updateFields.dryRunResult = dryRunResult;
    }

    await this.model.updateOne({ _id: id }, { $set: updateFields });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'failed',
          completedAt: new Date(),
          error,
        },
      }
    );
  }

  async hasActiveRunForConfig(configId: string): Promise<boolean> {
    const count = await this.model.countDocuments({
      configId,
      status: { $in: ['queued', 'processing'] },
    });
    return count > 0;
  }
}

export const LiveopsTriageRunModel: Model<ILiveopsTriageRunDocument> =
  (mongoose.models.LiveopsTriageRun as unknown as Model<ILiveopsTriageRunDocument>) ??
  model<ILiveopsTriageRunDocument>('LiveopsTriageRun', LiveopsTriageRunSchema);

export const liveopsTriageRunRepository = new LiveopsTriageRunRepository();
