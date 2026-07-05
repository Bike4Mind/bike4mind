import mongoose, { Model, model, Schema, Types } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/**
 * Issue tracker types supported for LiveOps triage
 */
export type LiveopsIssueTrackerType = 'github' | 'jira';

/**
 * Run interval options (hours)
 */
export type LiveopsRunIntervalHours = 6 | 12 | 24;

/**
 * Last run result status
 */
export type LiveopsRunResultStatus = 'success' | 'failure' | 'skipped';

/**
 * Last run result stored on the config
 */
export interface ILiveopsTriageLastRunResult {
  status: LiveopsRunResultStatus;
  errorsProcessed: number;
  issuesCreated: number;
  issuesDeduplicated: number;
  error?: string;
}

/**
 * LiveOps Triage Configuration Document
 * Supports multiple independent configurations, each with its own
 * Slack channel source and issue tracker (GitHub or Jira)
 */
export interface ILiveopsTriageConfigDocument extends IMongoDocument {
  name: string;
  enabled: boolean;

  // Slack settings
  slackWorkspaceId?: Types.ObjectId;
  slackChannelId: string;
  slackOutputChannelId?: string;

  // Issue tracker selection
  issueTracker: LiveopsIssueTrackerType;

  // GitHub settings (when issueTracker === 'github')
  githubOwner?: string;
  githubRepo?: string;

  // Jira settings (when issueTracker === 'jira')
  jiraProjectKey?: string;
  jiraIssueType?: string;

  // Schedule
  runIntervalHours: LiveopsRunIntervalHours;

  // LLM settings
  modelId: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  promptTemplate?: string;

  // Behavior settings
  maxErrorsPerRun: number;
  regressionLookbackDays: number;
  regressionGracePeriodHours: number;
  autoCreateIssues: boolean;
  postWhenNoErrors: boolean;

  // Tracking & Idempotency
  lastRunAt?: Date;
  lastRunStartedAt?: Date;
  lastRunResult?: ILiveopsTriageLastRunResult;

  // Resilience
  consecutiveFailures: number;
}

/**
 * Input for creating a new config
 */
export interface CreateLiveopsTriageConfigInput {
  name: string;
  enabled?: boolean;

  // Slack settings
  slackWorkspaceId?: Types.ObjectId | string;
  slackChannelId: string;
  slackOutputChannelId?: string;

  // Issue tracker
  issueTracker: LiveopsIssueTrackerType;

  // GitHub settings
  githubOwner?: string;
  githubRepo?: string;

  // Jira settings
  jiraProjectKey?: string;
  jiraIssueType?: string;

  // Schedule
  runIntervalHours?: LiveopsRunIntervalHours;

  // LLM settings
  modelId: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  promptTemplate?: string;

  // Behavior settings
  maxErrorsPerRun?: number;
  regressionLookbackDays?: number;
  regressionGracePeriodHours?: number;
  autoCreateIssues?: boolean;
  postWhenNoErrors?: boolean;
}

/**
 * Input for updating an existing config
 */
export interface UpdateLiveopsTriageConfigInput {
  name?: string;
  enabled?: boolean;

  // Slack settings
  slackWorkspaceId?: Types.ObjectId | string | null;
  slackChannelId?: string;
  slackOutputChannelId?: string | null;

  // Issue tracker
  issueTracker?: LiveopsIssueTrackerType;

  // GitHub settings
  githubOwner?: string | null;
  githubRepo?: string | null;

  // Jira settings
  jiraProjectKey?: string | null;
  jiraIssueType?: string | null;

  // Schedule
  runIntervalHours?: LiveopsRunIntervalHours;

  // LLM settings
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  promptTemplate?: string | null;

  // Behavior settings
  maxErrorsPerRun?: number;
  regressionLookbackDays?: number;
  regressionGracePeriodHours?: number;
  autoCreateIssues?: boolean;
  postWhenNoErrors?: boolean;
}

/**
 * Repository interface
 */
export interface ILiveopsTriageConfigRepository {
  findById(id: string): Promise<ILiveopsTriageConfigDocument | null>;
  findByName(name: string): Promise<ILiveopsTriageConfigDocument | null>;
  findAll(): Promise<ILiveopsTriageConfigDocument[]>;
  findEnabled(): Promise<ILiveopsTriageConfigDocument[]>;
  findEnabledByInterval(intervalHours: LiveopsRunIntervalHours): Promise<ILiveopsTriageConfigDocument[]>;
  createConfig(data: CreateLiveopsTriageConfigInput): Promise<ILiveopsTriageConfigDocument>;
  updateConfig(id: string, data: UpdateLiveopsTriageConfigInput): Promise<ILiveopsTriageConfigDocument | null>;
  deleteConfig(id: string): Promise<boolean>;
  isNameUnique(name: string, excludeId?: string): Promise<boolean>;
  markRunStarted(id: string): Promise<void>;
  /**
   * Atomically attempt to mark a run as started, only if no recent run exists.
   * Uses MongoDB's updateOne with conditions for race-free locking.
   * @param id Config ID
   * @param idempotencyWindowMs Window in ms to consider a run "recent"
   * @returns true if lock was acquired, false if another run is already in progress
   */
  atomicMarkRunStartedIfNotRecent(id: string, idempotencyWindowMs: number): Promise<boolean>;
  markRunComplete(id: string, result: ILiveopsTriageLastRunResult): Promise<void>;
  incrementConsecutiveFailures(id: string): Promise<number>;
  resetConsecutiveFailures(id: string): Promise<void>;
}

const LiveopsTriageConfigSchema = new Schema<ILiveopsTriageConfigDocument>(
  {
    name: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: false },

    // Slack settings
    slackWorkspaceId: { type: Schema.Types.ObjectId, ref: 'SlackDevWorkspace' },
    slackChannelId: { type: String, required: true },
    slackOutputChannelId: { type: String },

    // Issue tracker selection
    issueTracker: {
      type: String,
      required: true,
      enum: ['github', 'jira'],
    },

    // GitHub settings
    githubOwner: { type: String },
    githubRepo: { type: String },

    // Jira settings
    jiraProjectKey: { type: String },
    jiraIssueType: { type: String, default: 'Bug' },

    // Schedule
    runIntervalHours: {
      type: Number,
      required: true,
      enum: [6, 12, 24],
      default: 12,
    },

    // LLM settings
    modelId: { type: String, required: true },
    temperature: { type: Number, default: 0.3 },
    maxTokens: { type: Number, default: 1000 },
    timeoutMs: { type: Number, default: 60000 },
    promptTemplate: { type: String },

    // Behavior settings
    maxErrorsPerRun: { type: Number, default: 50 },
    regressionLookbackDays: { type: Number, default: 30 },
    regressionGracePeriodHours: { type: Number, default: 48 },
    autoCreateIssues: { type: Boolean, default: false },
    postWhenNoErrors: { type: Boolean, default: true },

    // Tracking & Idempotency
    lastRunAt: { type: Date },
    lastRunStartedAt: { type: Date },
    lastRunResult: {
      type: {
        status: { type: String, enum: ['success', 'failure', 'skipped'] },
        errorsProcessed: { type: Number },
        issuesCreated: { type: Number },
        issuesDeduplicated: { type: Number },
        error: { type: String },
      },
      required: false,
    },

    // Resilience
    consecutiveFailures: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
LiveopsTriageConfigSchema.index({ name: 1 }, { unique: true });
// Compound index serves both (enabled) and (enabled, runIntervalHours) queries
LiveopsTriageConfigSchema.index({ enabled: 1, runIntervalHours: 1 });

class LiveopsTriageConfigRepository
  extends BaseRepository<ILiveopsTriageConfigDocument>
  implements ILiveopsTriageConfigRepository
{
  constructor() {
    super(LiveopsTriageConfigModel);
  }

  async findById(id: string): Promise<ILiveopsTriageConfigDocument | null> {
    const result = await this.model.findById(id);
    return result?.toObject() ?? null;
  }

  async findByName(name: string): Promise<ILiveopsTriageConfigDocument | null> {
    const result = await this.model.findOne({ name });
    return result?.toObject() ?? null;
  }

  async findAll(): Promise<ILiveopsTriageConfigDocument[]> {
    const results = await this.model.find().sort({ name: 1 });
    return results.map(doc => doc.toObject());
  }

  async findEnabled(): Promise<ILiveopsTriageConfigDocument[]> {
    const results = await this.model.find({ enabled: true }).sort({ name: 1 });
    return results.map(doc => doc.toObject());
  }

  async findEnabledByInterval(intervalHours: LiveopsRunIntervalHours): Promise<ILiveopsTriageConfigDocument[]> {
    const results = await this.model.find({ enabled: true, runIntervalHours: intervalHours }).sort({ name: 1 });
    return results.map(doc => doc.toObject());
  }

  async createConfig(data: CreateLiveopsTriageConfigInput): Promise<ILiveopsTriageConfigDocument> {
    const result = await this.model.create({
      ...data,
      consecutiveFailures: 0,
    });
    return result.toObject();
  }

  async updateConfig(id: string, data: UpdateLiveopsTriageConfigInput): Promise<ILiveopsTriageConfigDocument | null> {
    const result = await this.model.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true });
    return result?.toObject() ?? null;
  }

  async deleteConfig(id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  async isNameUnique(name: string, excludeId?: string): Promise<boolean> {
    const query: Record<string, unknown> = { name };
    if (excludeId) {
      query._id = { $ne: excludeId };
    }
    const existing = await this.model.findOne(query);
    return !existing;
  }

  async markRunStarted(id: string): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          lastRunStartedAt: new Date(),
        },
      }
    );
  }

  async atomicMarkRunStartedIfNotRecent(id: string, idempotencyWindowMs: number): Promise<boolean> {
    const cutoffTime = new Date(Date.now() - idempotencyWindowMs);

    // Atomic test-and-set: only update if lastRunStartedAt is null OR older than cutoff
    // This prevents race conditions where two workers both pass the check
    const result = await this.model.updateOne(
      {
        _id: id,
        $or: [
          { lastRunStartedAt: { $exists: false } },
          { lastRunStartedAt: null },
          { lastRunStartedAt: { $lt: cutoffTime } },
        ],
      },
      {
        $set: {
          lastRunStartedAt: new Date(),
        },
      }
    );

    // If modifiedCount is 1, we successfully acquired the lock
    // If 0, another worker already has the lock (within the idempotency window)
    return result.modifiedCount === 1;
  }

  async markRunComplete(id: string, result: ILiveopsTriageLastRunResult): Promise<void> {
    // Always clear lastRunStartedAt on completion to allow subsequent runs
    // This prevents permanent idempotency block after failures
    const isSuccess = result.status === 'success';

    // Build update operation - use separate logic for success vs failure
    // to avoid MongoDB conflict between $set and $inc on same field
    const updateOp: Record<string, unknown> = {
      $set: {
        lastRunAt: new Date(),
        lastRunResult: result,
      },
      $unset: {
        lastRunStartedAt: 1,
      },
    };

    if (isSuccess) {
      // Reset consecutive failures on success
      (updateOp.$set as Record<string, unknown>).consecutiveFailures = 0;
    } else {
      // Increment consecutive failures on failure
      updateOp.$inc = { consecutiveFailures: 1 };
    }

    await this.model.updateOne({ _id: id }, updateOp);
  }

  async incrementConsecutiveFailures(id: string): Promise<number> {
    const result = await this.model.findByIdAndUpdate(id, { $inc: { consecutiveFailures: 1 } }, { new: true });
    return result?.consecutiveFailures ?? 0;
  }

  async resetConsecutiveFailures(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { consecutiveFailures: 0 } });
  }
}

export const LiveopsTriageConfigModel: Model<ILiveopsTriageConfigDocument> =
  (mongoose.models.LiveopsTriageConfig as unknown as Model<ILiveopsTriageConfigDocument>) ??
  model<ILiveopsTriageConfigDocument>('LiveopsTriageConfig', LiveopsTriageConfigSchema);

export const liveopsTriageConfigRepository = new LiveopsTriageConfigRepository();
