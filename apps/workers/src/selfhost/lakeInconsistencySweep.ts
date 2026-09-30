import { runLakeInconsistencySweep } from '@server/cron/lakeInconsistencySweep';
import type { SelfHostWorker } from './selfHostWorker';

export function registerLakeInconsistencySweep(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  // Mirrors the hosted 04:00 UTC schedule in infra/cron.ts.
  worker.registerDailyUtcTask('lakeInconsistencySweep', 4, async () => {
    await runLakeInconsistencySweep();
  });
}
