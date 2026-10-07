import { runLakeHealthSweep } from '@workers/cron/lakeHealthSweep';
import type { SelfHostWorker } from './selfHostWorker';

export function registerLakeHealthSweep(worker: SelfHostWorker): void {
  worker.registerDailyUtcTask('lakeHealthSweep', 6, async () => {
    await runLakeHealthSweep({ emitMetrics: false });
  });
}
