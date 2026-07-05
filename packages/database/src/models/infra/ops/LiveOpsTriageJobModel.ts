import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * LiveOps Triage Job Result
 * Stores the outcome of a triage run. Flexible shape - varies between dry-run and actual runs.
 */
export interface ILiveOpsTriageJobResult {
  // Common fields
  status: 'success' | 'partial' | 'failed';

  // Dry run fields
  dryRun?: boolean;
  alertsFetched?: number;
  alertsToProcess?: number;
  existingIssuesFound?: number;
  triageResults?: Array<{
    alertId: string;
    priority: string;
    title: string;
    category: string;
    matchesExisting: { issueNumber: number; title: string; state?: 'open' | 'closed' } | null;
    isRecurring: boolean;
    occurrenceCount: number;
    isRegression: boolean;
  }>;
  summary?: {
    totalAlerts: number;
    newIssues: number;
    duplicates: number;
    regressions: number;
    p0Count: number;
    p1Count: number;
    p2Count: number;
    p3Count: number;
    healthAssessment: string;
    recurringPatterns?: string[] | Array<{ pattern: string; count: number }>;
  };
  issuesWouldCreate?: Array<{
    title: string;
    priority: string;
    category?: string;
    body?: string;
    labels?: string[];
    isRecurring?: boolean;
    occurrenceCount?: number;
    isRegression?: boolean;
  }>;
  issuesWouldSkip?: Array<{
    title: string;
    priority?: string;
    reason?: string;
    matchesExisting?: { issueNumber: number; title: string; state?: 'open' | 'closed' };
  }>;
  llmDetails?: {
    modelId: string;
    promptLength: number;
    responseLength: number;
    estimatedCost: string;
  };
  error?: string;

  // Actual run fields
  errorsProcessed?: number;
  issuesCreated?: Array<{ number: number; title: string; url: string }>;
  issuesDeduplicated?: number;
  p0Issues?: Array<{ number: number; title: string }>;
  p1Issues?: Array<{ number: number; title: string }>;
}

/**
 * LiveOps Triage Job
 * Tracks async manual triage runs (dry-run and actual)
 */
export interface ILiveOpsTriageJob {
  id: string;
  userId: string;

  // Job type
  dryRun: boolean;

  // Status tracking
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
  currentStep: string;

  // Results (on completion)
  result?: ILiveOpsTriageJobResult;

  // Error handling
  errorMessage?: string;

  // Timing
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

const LiveOpsTriageJobSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },

    // Job type
    dryRun: { type: Boolean, required: true, default: false },

    // Status tracking
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      required: true,
      default: 'pending',
    },
    progress: { type: Number, default: 0 },
    currentStep: { type: String, default: 'Queued for processing...' },

    // Results (on completion)
    result: {
      type: mongoose.Schema.Types.Mixed,
      required: false,
    },

    // Error handling
    errorMessage: { type: String },

    // Timing
    startedAt: { type: Date },
    completedAt: { type: Date },
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

// Partial unique index - only one pending/processing job allowed at a time
// This enforces the mutex at the database level to prevent race conditions
LiveOpsTriageJobSchema.index(
  { status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['pending', 'processing'] } },
  }
);

// For status polling by job ID
LiveOpsTriageJobSchema.index({ _id: 1, status: 1 });

// For stuck job detection (cleanup cron)
LiveOpsTriageJobSchema.index({ status: 1, startedAt: 1 });

// For listing job history
LiveOpsTriageJobSchema.index({ createdAt: -1 });

// TTL - auto-delete completed/failed jobs after 14 days
LiveOpsTriageJobSchema.index({ completedAt: 1 }, { expireAfterSeconds: 1209600, sparse: true });

class LiveOpsTriageJobRepository extends BaseRepository<ILiveOpsTriageJob> {
  constructor(private liveOpsTriageJobModel: mongoose.Model<ILiveOpsTriageJob>) {
    super(liveOpsTriageJobModel);
    this.model = liveOpsTriageJobModel;
  }

  async findById(id: string): Promise<ILiveOpsTriageJob | null> {
    const result = await this.model.findById(id);
    return result?.toObject() ?? null;
  }

  /**
   * Find the currently active job (pending or processing)
   */
  async findActiveJob(): Promise<ILiveOpsTriageJob | null> {
    const result = await this.model.findOne({
      status: { $in: ['pending', 'processing'] },
    });
    return result?.toObject() ?? null;
  }

  /**
   * Atomic mutex: Create job only if no active job exists.
   * Uses unique partial index to prevent race conditions.
   *
   * @returns { created: true, job } if job was created
   * @returns { created: false, activeJob } if an active job already exists
   */
  async createIfNoActiveJob(
    data: Omit<Partial<ILiveOpsTriageJob>, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<{ created: true; job: ILiveOpsTriageJob } | { created: false; activeJob: ILiveOpsTriageJob }> {
    try {
      // Attempt to create - unique partial index will reject if active job exists
      const job = await this.model.create(data);
      return { created: true, job: job.toObject() };
    } catch (error) {
      // Check if this is a duplicate key error (E11000)
      if (error instanceof Error && 'code' in error && (error as { code: number }).code === 11000) {
        // Another job is already active, find and return it
        const activeJob = await this.findActiveJob();
        if (activeJob) {
          return { created: false, activeJob };
        }
        // Edge case: job completed between our create and this query
        // Retry the create
        const retryJob = await this.model.create(data);
        return { created: true, job: retryJob.toObject() };
      }
      throw error;
    }
  }

  /**
   * Update job progress and current step
   */
  async updateProgress(id: string, progress: number, currentStep: string): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          progress,
          currentStep,
          updatedAt: new Date(),
        },
      }
    );
  }

  /**
   * Mark job as started (processing)
   */
  async markStarted(id: string): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'processing',
          startedAt: new Date(),
          currentStep: 'Starting...',
          updatedAt: new Date(),
        },
      }
    );
  }

  /**
   * Mark job as completed with results
   */
  async markComplete(id: string, result: ILiveOpsTriageJobResult): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'completed',
          progress: 100,
          currentStep: 'Complete',
          result,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );
  }

  /**
   * Mark job as failed with error message
   */
  async markFailed(id: string, error: { errorMessage: string }): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'failed',
          currentStep: 'Failed',
          errorMessage: error.errorMessage,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );
  }

  /**
   * Mark stuck jobs as failed.
   * Called by cleanup cron to handle Lambda timeouts and lost SQS messages.
   *
   * Handles two scenarios:
   * 1. Processing jobs: Lambda timed out mid-execution
   * 2. Pending jobs: SQS message was lost or never delivered
   *
   * @param stuckThresholdMinutes Jobs older than this are considered stuck
   * @returns Number of jobs marked as failed
   */
  async markStuckJobsFailed(stuckThresholdMinutes: number): Promise<number> {
    const stuckThreshold = new Date(Date.now() - stuckThresholdMinutes * 60 * 1000);

    const result = await this.model.updateMany(
      {
        // Handle both stuck pending and stuck processing jobs
        $or: [
          // Processing jobs that started too long ago (Lambda timeout)
          { status: 'processing', startedAt: { $lt: stuckThreshold } },
          // Pending jobs that were created too long ago (SQS message lost)
          { status: 'pending', createdAt: { $lt: stuckThreshold } },
        ],
      },
      {
        $set: {
          status: 'failed',
          currentStep: 'Failed - Processing timeout',
          errorMessage: `Job timed out after ${stuckThresholdMinutes} minutes`,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );

    return result.modifiedCount;
  }

  /**
   * Get recent jobs for display
   */
  async findRecent(limit = 10): Promise<ILiveOpsTriageJob[]> {
    const results = await this.model.find().sort({ createdAt: -1 }).limit(limit);
    return results.map(doc => doc.toObject());
  }
}

const LiveOpsTriageJobModel =
  (mongoose.models['LiveOpsTriageJob'] as unknown as mongoose.Model<ILiveOpsTriageJob>) ||
  mongoose.model<ILiveOpsTriageJob>('LiveOpsTriageJob', LiveOpsTriageJobSchema);

export const liveOpsTriageJobRepository = new LiveOpsTriageJobRepository(LiveOpsTriageJobModel);

export default LiveOpsTriageJobModel;
