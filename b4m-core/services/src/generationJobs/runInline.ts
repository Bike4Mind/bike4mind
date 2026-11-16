import {
  TERMINAL_GENERATION_JOB_STATES,
  type IGenerationJobDocument,
  type IGenerationJobRepository,
} from '@bike4mind/common';
import type { GenerationJobEngine } from './engine';

const DEFAULT_POLL_INTERVAL_MS = 500;

export type RunJobInlineDeps = {
  engine: Pick<GenerationJobEngine, 'step'>;
  repository: Pick<IGenerationJobRepository, 'findById'>;
  now(): Date;
  sleep?(ms: number): Promise<void>;
};

export type RunJobInlineOptions = {
  /** How long to wait for the job to end, from now. */
  timeoutMs: number;
  /** The least step budget to start a step with: one full provider call. */
  minStepMs: number;
  /**
   * Time kept back from each step's budget for what runs after it, inside the wait: the store fallback, the commit
   * and the terminal settlement. Defaults to 0, a step that may run to the end of the wait.
   */
  stepReserveMs?: number;
  pollIntervalMs?: number;
};

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const timeOf = (date: Date | null | undefined): number => (date ? new Date(date).getTime() : 0);

/**
 * When a step can next do anything: not while another worker holds the lease, nor before a retry backoff's
 * nextPollAt (the engine would only skip it, after a lease write).
 */
const dueAt = (job: IGenerationJobDocument): number => Math.max(timeOf(job.leaseUntil), timeOf(job.nextPollAt));

/**
 * Steps a just-created job in this process and waits for it to end, for a caller that must answer synchronously
 * (the legacy audio routes, the chat audio tool). The job's queued message stays as the backstop: whichever of this
 * caller and the worker leases the job first runs the step, the other skips, and a job that waits on a retry
 * backoff is picked up by whichever comes back first. Between steps it only reads the job, stepping again once the
 * job is due.
 *
 * A step is given what is left of the wait minus `stepReserveMs`, and is only started while that is at least
 * `minStepMs`, so a sync submit is never cut short mid-call (an aborted call fails as orphaned_submit after the
 * provider may have billed). Below that it only polls, and the worker's queued message runs the step with a full
 * budget.
 *
 * Returns the terminal job, or null when it is gone or did not end within `timeoutMs`; it then carries on with the
 * worker, which bills (or refunds) it as usual.
 */
export async function runJobInline(
  jobId: string,
  options: RunJobInlineOptions,
  deps: RunJobInlineDeps
): Promise<IGenerationJobDocument | null> {
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = deps.now().getTime() + options.timeoutMs;
  const stepReserveMs = options.stepReserveMs ?? 0;
  // A just-created job is due at once.
  let nextStepAt = 0;
  for (;;) {
    const now = deps.now().getTime();
    if (deadline - now <= 0) return null;
    const stepBudgetMs = deadline - now - stepReserveMs;
    if (now >= nextStepAt && stepBudgetMs >= options.minStepMs) {
      await deps.engine.step(jobId, { stepBudgetMs });
    }
    const job = await deps.repository.findById(jobId);
    if (!job) return null;
    if (TERMINAL_GENERATION_JOB_STATES.includes(job.state)) return job;
    nextStepAt = dueAt(job);
    await sleep(
      Math.min(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, Math.max(0, deadline - deps.now().getTime()))
    );
  }
}
