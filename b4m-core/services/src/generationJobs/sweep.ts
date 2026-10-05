import type { IGenerationJobRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

export const SWEEP_OVERDUE_MS = 5 * 60_000;
const SWEEP_LIMIT = 200;

// Recovers jobs whose SQS message was lost or whose worker died mid-step; the engine's lease makes a spurious re-enqueue harmless.
export async function runGenerationJobSweep(
  deps: {
    repository: IGenerationJobRepository;
    enqueue(jobId: string, delaySeconds: number): Promise<void>;
    now(): Date;
    logger: Logger;
  },
  options: { overdueMs?: number; limit?: number } = {}
): Promise<{ requeued: number }> {
  const overdueBefore = new Date(deps.now().getTime() - (options.overdueMs ?? SWEEP_OVERDUE_MS));
  const stalled = await deps.repository.findStalled(overdueBefore, options.limit ?? SWEEP_LIMIT);
  let requeued = 0;
  for (const job of stalled) {
    try {
      await deps.enqueue(job.id, 0);
      requeued += 1;
    } catch (error) {
      // One bad send must not strand the rest of the batch; the job stays stalled and the next sweep retries it.
      deps.logger.error('generation_job_sweep_enqueue_failed', { jobId: job.id, error });
    }
  }
  if (requeued > 0) deps.logger.warn('generation job sweep re-enqueued stalled jobs', { count: requeued });
  return { requeued };
}
