import { runLakeInconsistencySweep } from '@server/cron/lakeInconsistencySweep';
import type { SelfHostWorker } from './selfHostWorker';

export function registerLakeInconsistencySweep(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  worker.registerDailyUtcTask('lakeInconsistencySweep', 4, async () => {
    await runLakeInconsistencySweep();
  });
}
