import { runAccountDeletionSweep } from '@workers/cron/accountDeletionSweep';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted accountDeletionSweep cron's daily slot in infra/cron.ts. */
export function registerAccountDeletionSweep(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  worker.registerDailyUtcTask('accountDeletionSweep', 5, async () => {
    await runAccountDeletionSweep();
  });
}
