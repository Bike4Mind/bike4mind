import { runCreditHoldSweep } from '@workers/cron/creditHoldSweep';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted creditHoldSweep cron's rate(15 minutes) in infra/cron.ts; keep them in step. */
export const CREDIT_HOLD_SWEEP_INTERVAL_MS = 15 * 60_000;

export function registerCreditHoldSweep(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask(
    'creditHoldSweep',
    CREDIT_HOLD_SWEEP_INTERVAL_MS,
    async () => {
      const result = await runCreditHoldSweep({ emitMetrics: false });
      if (result.failed > 0) throw new Error(`Failed to refund ${result.failed} expired credit hold(s)`);
    },
    // Expiry is stored on each hold, so a boot run refunds only what the next tick would, sooner.
    { runOnStartup: true }
  );
}
