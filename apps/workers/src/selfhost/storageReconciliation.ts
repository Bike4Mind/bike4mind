import { optionsFromEnv, runStorageReconciliation } from '@workers/cron/storageReconciliation';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted storageReconciliation cron's rate(1 hour) in infra/cron.ts. */
export const STORAGE_RECONCILIATION_INTERVAL_MS = 60 * 60_000;

export function registerStorageReconciliation(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask('storageReconciliation', STORAGE_RECONCILIATION_INTERVAL_MS, async () => {
    // Thresholds stay tunable from env, but repair is forced off: self-host never rewrites counters.
    await runStorageReconciliation({ ...optionsFromEnv(), repair: false, emitMetrics: false });
  });
}
