import { randomBytes } from 'crypto';
import type { SubagentOrchestrator, SpawnAgentOptions, AgentExecutionResult } from './SubagentOrchestrator.js';
import type { BackgroundAgentJob, BackgroundAgentStatus } from './types.js';

/**
 * Callback invoked when a background agent job changes status
 */
export type JobStatusCallback = (job: BackgroundAgentJob) => void;

/**
 * Callback invoked when all jobs in a turn group complete
 */
export type GroupCompletionCallback = (notification: string, groupDescription?: string) => void;

/**
 * Notification data for a single job in a turn group
 */
interface TurnGroupNotification {
  jobId: string;
  agentName: string;
  task: string;
  status: 'completed' | 'failed' | 'cancelled';
  content: string;
}

/**
 * Tracks jobs spawned in the same LLM turn for consolidated notifications
 */
interface TurnGroup {
  turnId: string;
  description?: string;
  jobIds: string[];
  notifications: TurnGroupNotification[];
}

/**
 * Result of spawning an agent with a future.
 * The promise resolves when the job completes (or rejects on failure).
 */
export interface SpawnWithFutureResult {
  /** Unique job ID for status tracking */
  jobId: string;
  /** Promise that resolves with the agent's result when the job completes */
  result: Promise<AgentExecutionResult>;
}

/**
 * Internal job state including the promise and abort controller
 */
interface InternalJob {
  job: BackgroundAgentJob;
  options: SpawnAgentOptions;
  promise?: Promise<AgentExecutionResult | void>;
  abortController: AbortController;
  result?: AgentExecutionResult;
  /** Externally-visible resolve/reject for the result future */
  futureResolve?: (result: AgentExecutionResult) => void;
  futureReject?: (error: Error) => void;
}

/** Default max concurrent background agents (1 main agent + N background = N+1 total connections) */
const DEFAULT_MAX_CONCURRENT = 4;

/** Terminal job statuses - job has finished and won't change */
const TERMINAL_STATUSES: ReadonlySet<BackgroundAgentStatus> = new Set(['completed', 'failed', 'cancelled']);

/** Checks if a job status is terminal (completed, failed, or cancelled) */
function isTerminalStatus(status: BackgroundAgentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Default max age for completed jobs before cleanup (1 hour) */
const DEFAULT_MAX_JOB_AGE_MS = 60 * 60 * 1000;

/** Maximum number of jobs to keep before forcing cleanup */
const MAX_JOBS_BEFORE_CLEANUP = 100;

/** Returns 's' suffix for counts other than 1 */
function pluralize(count: number): string {
  return count === 1 ? '' : 's';
}

/**
 * Manages background agent execution with concurrency control.
 *
 * Limits concurrent background agents to avoid hitting API rate limits
 * on concurrent connections. Excess spawns are queued and started
 * as running agents complete.
 */
export class BackgroundAgentManager {
  private jobs = new Map<string, InternalJob>();
  private queue: string[] = []; // Job IDs waiting to start
  private runningCount = 0;
  private maxConcurrent: number;
  private onStatusChange: JobStatusCallback | null = null;
  private onGroupCompletion: GroupCompletionCallback | null = null;
  private orchestrator: SubagentOrchestrator;
  private pendingNotifications: string[] = [];
  private turnGroups = new Map<string, TurnGroup>();
  private currentTurnId: string | null = null;

  constructor(orchestrator: SubagentOrchestrator, maxConcurrent = DEFAULT_MAX_CONCURRENT) {
    this.orchestrator = orchestrator;
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Set the current turn ID. Jobs spawned while this is set will be grouped.
   * Call with null to clear (after agent.run() completes).
   */
  setCurrentTurn(turnId: string | null): void {
    this.currentTurnId = turnId;
  }

  /**
   * Get the current turn ID (for testing/debugging)
   */
  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  /**
   * Set a callback that fires whenever a job changes status.
   * Used to update the Zustand store / UI.
   */
  setOnStatusChange(callback: JobStatusCallback | null): void {
    this.onStatusChange = callback;
  }

  /**
   * Set a callback that fires when all jobs in a turn group complete.
   * Used to notify the user that background work is done.
   */
  setOnGroupCompletion(callback: GroupCompletionCallback | null): void {
    this.onGroupCompletion = callback;
  }

  /**
   * Spawn an agent in the background. Returns the job ID immediately.
   * If concurrency limit is reached, the job is queued and starts when a slot opens.
   */
  spawn(options: SpawnAgentOptions): string {
    const id = `bg-${randomBytes(4).toString('hex')}`;
    const abortController = new AbortController();

    const isQueued = this.runningCount >= this.maxConcurrent;

    const job: BackgroundAgentJob = {
      id,
      agentName: options.agentName,
      task: options.task,
      status: isQueued ? 'queued' : 'running',
      startTime: Date.now(),
      turnId: this.currentTurnId ?? undefined,
      groupDescription: options.groupDescription,
    };

    // Key the stored history to the job id so resume_agent can continue this
    // run under the same id the model already has.
    const internal: InternalJob = { job, options: { ...options, resumeId: id }, abortController };
    this.jobs.set(id, internal);
    this.notifyStatusChange(job);

    // Track job in turn group if spawned within a turn
    if (this.currentTurnId) {
      let group = this.turnGroups.get(this.currentTurnId);
      if (!group) {
        group = {
          turnId: this.currentTurnId,
          description: options.groupDescription,
          jobIds: [],
          notifications: [],
        };
        this.turnGroups.set(this.currentTurnId, group);
      } else if (options.groupDescription && !group.description) {
        // Set group description if not already set
        group.description = options.groupDescription;
      }
      group.jobIds.push(id);
    }

    if (isQueued) {
      this.queue.push(id);
    } else {
      this.startJob(internal);
    }

    return id;
  }

  /**
   * Spawn an agent and return both the job ID and a result promise.
   *
   * The promise resolves when the job completes successfully, or rejects
   * if the job fails or is cancelled. Existing fire-and-forget workflows
   * can continue using spawn() - this adds explicit await-based coordination.
   */
  spawnWithFuture(options: SpawnAgentOptions): SpawnWithFutureResult {
    // spawn() is synchronous - safe to call inside the Promise executor
    let capturedJobId = '';

    const result = new Promise<AgentExecutionResult>((resolve, reject) => {
      capturedJobId = this.spawn(options);
      const internal = this.jobs.get(capturedJobId);
      if (!internal) {
        reject(new Error('Failed to create job'));
        return;
      }

      // delegateToAgent is always async, so the job is guaranteed to be
      // in 'running' or 'queued' state here. The .then()/.catch() handlers
      // in startJob() will call futureResolve/futureReject when it settles.
      internal.futureResolve = resolve;
      internal.futureReject = reject;
    });

    return { jobId: capturedJobId, result };
  }

  /**
   * Get a job by ID (public-facing snapshot without internals)
   */
  getJob(id: string): BackgroundAgentJob | undefined {
    return this.jobs.get(id)?.job;
  }

  /**
   * Get the full result of a completed job
   */
  getResult(id: string): AgentExecutionResult | undefined {
    return this.jobs.get(id)?.result;
  }

  /**
   * List all jobs (public-facing snapshots)
   */
  listJobs(): BackgroundAgentJob[] {
    return Array.from(this.jobs.values()).map(j => j.job);
  }

  /**
   * Cancel a running or queued job
   */
  cancelJob(id: string): boolean {
    const internal = this.jobs.get(id);
    if (!internal) return false;

    if (internal.job.status === 'queued') {
      this.queue = this.queue.filter(qid => qid !== id);
      this.updateJob(id, { status: 'cancelled', endTime: Date.now() });
      internal.futureReject?.(new Error('Job was cancelled'));
      return true;
    }

    if (internal.job.status === 'running') {
      internal.abortController.abort();
      this.updateJob(id, { status: 'cancelled', endTime: Date.now() });
      internal.futureReject?.(new Error('Job was cancelled'));
      this.runningCount--;
      this.processQueue();
      return true;
    }

    return false;
  }

  /**
   * Drain all pending notifications (called by the LLM wrapper before each completion).
   * Returns notification strings and clears the queue.
   */
  drainNotifications(): string[] {
    return this.pendingNotifications.splice(0);
  }

  /**
   * Handle job completion - routes to grouped or immediate notification
   */
  private handleJobCompletion(
    job: BackgroundAgentJob,
    status: 'completed' | 'failed' | 'cancelled',
    content: string
  ): void {
    // If job is part of a turn group, collect notification and check group completion
    if (job.turnId) {
      const group = this.turnGroups.get(job.turnId);
      if (group) {
        group.notifications.push({
          jobId: job.id,
          agentName: job.agentName,
          task: job.task,
          status,
          content,
        });
        this.checkTurnGroupCompletion(job.turnId);
        return;
      }
    }

    // Not in a group - push immediate notification (legacy behavior)
    this.pendingNotifications.push(content);
  }

  /**
   * Check if all jobs in a turn group have completed
   */
  private checkTurnGroupCompletion(turnId: string): void {
    const group = this.turnGroups.get(turnId);
    if (!group) return;

    // Check if all jobs in the group are terminal
    const allComplete = group.jobIds.every(jobId => {
      const internal = this.jobs.get(jobId);
      return internal && isTerminalStatus(internal.job.status);
    });

    if (allComplete) {
      const notification = this.createConsolidatedNotification(group);
      this.pendingNotifications.push(notification);

      // Notify listener that a group completed (for immediate user feedback)
      if (this.onGroupCompletion) {
        this.onGroupCompletion(notification, group.description);
      }

      // Clean up the group
      this.turnGroups.delete(turnId);

      // Opportunistically clean up old jobs to prevent memory leaks
      this.cleanupOldJobs();
    }
  }

  /**
   * Create a consolidated notification for a completed turn group
   */
  private createConsolidatedNotification(group: TurnGroup): string {
    // Count status types in single pass
    const statusCounts = { completed: 0, failed: 0, cancelled: 0 };
    for (const notification of group.notifications) {
      statusCounts[notification.status]++;
    }

    const total = group.notifications.length;
    const statsSummary = Object.entries(statusCounts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');

    // Aggregate usage across the group's jobs (only completed jobs carry usage)
    let groupTokens = 0;
    let groupCredits = 0;
    for (const notification of group.notifications) {
      const job = this.jobs.get(notification.jobId)?.job;
      groupTokens += job?.totalTokens ?? 0;
      groupCredits += job?.totalCredits ?? 0;
    }
    const usageSummary =
      groupTokens > 0
        ? `, ${groupTokens.toLocaleString()} tokens${groupCredits > 0 ? ` / ${groupCredits.toLocaleString()} credits` : ''}`
        : '';

    // Header with optional group description
    const agentCount = `${total} agent${pluralize(total)} finished`;
    const header = group.description
      ? `[Background Agents Completed] "${group.description}" - ${agentCount} (${statsSummary}${usageSummary})`
      : `[Background Agents Completed] ${agentCount} (${statsSummary}${usageSummary})`;

    // Individual agent results
    const details = group.notifications
      .map(n => {
        const statusLabel = n.status.toUpperCase();
        return `=== Agent "${n.agentName}" (job ${n.jobId}) - ${statusLabel} ===\nTask: ${n.task}\n${n.status === 'completed' ? 'Result' : 'Error'}:\n${n.content}`;
      })
      .join('\n\n');

    return `${header}\n\n${details}`;
  }

  private startJob(internal: InternalJob): void {
    this.runningCount++;
    this.updateJob(internal.job.id, { status: 'running' });

    const { job, options } = internal;

    internal.promise = this.orchestrator
      .delegateToAgent({ ...options, abortSignal: internal.abortController.signal })
      .then(result => {
        // If already cancelled via cancelJob(), skip completion handling
        if (internal.abortController.signal.aborted) return;

        this.updateJob(job.id, {
          status: 'completed',
          endTime: Date.now(),
          resultSummary: result.summary,
          totalTokens: result.completionInfo.totalTokens,
          totalCredits: result.completionInfo.totalCredits,
        });
        internal.result = result;
        internal.futureResolve?.(result);
        this.handleJobCompletion(job, 'completed', result.summary);
        return result;
      })
      .catch(error => {
        const isCancelled = internal.abortController.signal.aborted;
        const errorMsg = error instanceof Error ? error.message : String(error);
        const status = isCancelled ? 'cancelled' : 'failed';
        this.updateJob(job.id, {
          status,
          endTime: Date.now(),
          error: errorMsg,
        });
        internal.futureReject?.(new Error(isCancelled ? 'Job was cancelled' : errorMsg));
        this.handleJobCompletion(job, status as 'failed' | 'cancelled', errorMsg);
      })
      .finally(() => {
        this.runningCount--;
        this.processQueue();
      });
  }

  /** Start the next queued job if there's capacity */
  private processQueue(): void {
    while (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      const nextId = this.queue.shift()!;
      const internal = this.jobs.get(nextId);
      if (internal && internal.job.status === 'queued') {
        this.startJob(internal);
      }
    }
  }

  private updateJob(id: string, updates: Partial<BackgroundAgentJob>): void {
    const internal = this.jobs.get(id);
    if (!internal) return;
    Object.assign(internal.job, updates);
    this.notifyStatusChange(internal.job);
  }

  private notifyStatusChange(job: BackgroundAgentJob): void {
    if (this.onStatusChange) {
      this.onStatusChange({ ...job });
    }
  }

  /**
   * Clean up old completed jobs to prevent memory leaks.
   * Removes jobs that have been in a terminal state for longer than maxAgeMs.
   * Also removes jobs when total count exceeds MAX_JOBS_BEFORE_CLEANUP.
   */
  cleanupOldJobs(maxAgeMs: number = DEFAULT_MAX_JOB_AGE_MS): number {
    const now = Date.now();
    let cleanedCount = 0;

    // First pass: remove jobs older than maxAgeMs
    for (const [id, internal] of this.jobs.entries()) {
      if (isTerminalStatus(internal.job.status) && internal.job.endTime && now - internal.job.endTime > maxAgeMs) {
        this.jobs.delete(id);
        cleanedCount++;
      }
    }

    // Second pass: if still over limit, remove oldest completed jobs
    if (this.jobs.size > MAX_JOBS_BEFORE_CLEANUP) {
      const completedJobs = Array.from(this.jobs.entries())
        .filter(([, j]) => isTerminalStatus(j.job.status))
        .sort((a, b) => (a[1].job.endTime || 0) - (b[1].job.endTime || 0));

      const toRemove = completedJobs.slice(0, this.jobs.size - MAX_JOBS_BEFORE_CLEANUP + 10);
      for (const [id] of toRemove) {
        this.jobs.delete(id);
        cleanedCount++;
      }
    }

    return cleanedCount;
  }

  /**
   * Get the current number of jobs (for monitoring)
   */
  getJobCount(): { total: number; running: number; queued: number; completed: number } {
    let running = 0;
    let queued = 0;
    let completed = 0;

    for (const internal of this.jobs.values()) {
      switch (internal.job.status) {
        case 'running':
          running++;
          break;
        case 'queued':
          queued++;
          break;
        default:
          completed++;
      }
    }

    return { total: this.jobs.size, running, queued, completed };
  }
}
