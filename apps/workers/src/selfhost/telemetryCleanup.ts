import { runTelemetryCleanup } from '@workers/cron/telemetryCleanup';
import type { SelfHostWorker } from './selfHostWorker';

export function registerTelemetryCleanup(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  worker.registerDailyUtcTask('telemetryCleanup', 3, async () => {
    await runTelemetryCleanup();
  });
}
