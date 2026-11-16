import {
  TERMINAL_GENERATION_JOB_STATES,
  type IGenerationJobDocument,
  type IGenerationJobRepository,
} from '@bike4mind/common';
import type { GenerationJobEngine } from './engine';

// Mirrors the engine's STEP_COMMIT_MARGIN_MS: a step stops this long before the time it is given, to commit.
const STEP_COMMIT_MARGIN_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export type RunJobInlineDeps = {
  engine: Pick<GenerationJobEngine, 'step'>;
  repository: Pick<IGenerationJobRepository, 'findById'>;
  now(): Date;
  sleep?(ms: number): Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Steps a just-created job in this process and waits for it to end, for a caller that must answer synchronously
 * (the legacy audio routes, the chat audio tool). The job's queued message stays as the backstop: whichever of this
 * caller and the worker leases the job first runs the step, the other skips, and a job that waits on a retry
 * backoff is picked up by whichever comes back first.
 *
 * A step is only started here while at least `minStepMs` of the wait remains, so a sync submit is never cut short
 * mid-call (an aborted call fails as orphaned_submit after the provider may have billed). Below that it only polls,
 * and the worker's queued message runs the step with a full budget.
 *
 * Returns the terminal job, or null when it is gone or did not end within `timeoutMs`; it then carries on with the
 * worker, which bills (or refunds) it as usual.
 */
export async function runJobInline(
  jobId: string,
  options: { timeoutMs: number; minStepMs: number; pollIntervalMs?: number },
  deps: RunJobInlineDeps
): Promise<IGenerationJobDocument | null> {
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = deps.now().getTime() + options.timeoutMs;
  for (;;) {
    const remainingMs = deadline - deps.now().getTime();
    if (remainingMs <= 0) return null;
    if (remainingMs >= options.minStepMs) {
      await deps.engine.step(jobId, { remainingMs: remainingMs + STEP_COMMIT_MARGIN_MS });
    }
    const job = await deps.repository.findById(jobId);
    if (!job) return null;
    if (TERMINAL_GENERATION_JOB_STATES.includes(job.state)) return job;
    await sleep(
      Math.min(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, Math.max(0, deadline - deps.now().getTime()))
    );
  }
}
