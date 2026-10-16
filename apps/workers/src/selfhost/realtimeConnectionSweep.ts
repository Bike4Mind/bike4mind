import { runRealtimeConnectionSweep } from '@workers/cron/realtimeConnectionSweep';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted realtimeConnectionSweep cron's rate(5 minutes) in infra/cron.ts. */
export const REALTIME_CONNECTION_SWEEP_INTERVAL_MS = 5 * 60_000;

export function registerRealtimeConnectionSweep(worker: SelfHostWorker): void {
  worker.registerScheduledTask(
    'realtimeConnectionSweep',
    REALTIME_CONNECTION_SWEEP_INTERVAL_MS,
    async () => {
      await runRealtimeConnectionSweep();
    },
    // Closes through the self-host gateway's DELETE /@connections/{id}; a boot run only does sooner what the next tick would.
    { runOnStartup: true }
  );
}
