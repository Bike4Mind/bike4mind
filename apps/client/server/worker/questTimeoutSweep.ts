import { runQuestTimeoutSweep } from '@server/cron/questTimeoutSweep';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted questTimeoutSweep cron's rate(5 minutes) in infra/cron.ts. */
export const QUEST_TIMEOUT_SWEEP_INTERVAL_MS = 5 * 60_000;

export function registerQuestTimeoutSweep(worker: SelfHostWorker): void {
  worker.registerScheduledTask(
    'questTimeoutSweep',
    QUEST_TIMEOUT_SWEEP_INTERVAL_MS,
    async () => {
      await runQuestTimeoutSweep({ emitMetrics: false });
    },
    // Staleness is judged from updatedAt at run time, so a boot run settles only what the
    // next tick would, sooner. It also keeps a worker that restarts inside one interval sweeping.
    { runOnStartup: true }
  );
}
