import { runGenerationJobSweepCron } from '@workers/cron/generationJobSweep';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted generationJobSweep cron's rate(5 minutes) in infra/cron.ts. */
export const GENERATION_JOB_SWEEP_INTERVAL_MS = 5 * 60_000;

export function registerGenerationJobSweep(worker: SelfHostWorker): void {
  worker.registerScheduledTask(
    'generationJobSweep',
    GENERATION_JOB_SWEEP_INTERVAL_MS,
    async () => {
      await runGenerationJobSweepCron();
    },
    // Overdue-ness is judged from the job's own timestamps, so a boot run only recovers what the next tick would, sooner.
    { runOnStartup: true }
  );
}
