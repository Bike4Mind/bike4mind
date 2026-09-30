import { runAbandonedExecutionSweep } from '@server/cron/agentExecutionAbandonedSweep';
import type { SelfHostWorker } from './selfHostWorker';

export function registerAbandonedExecutionSweep(worker: SelfHostWorker): void {
  worker.registerScheduledTask(
    'agentExecutionAbandonedSweep',
    60 * 60_000,
    async () => {
      await runAbandonedExecutionSweep({ emitMetrics: false });
    },
    { runOnStartup: true }
  );
}
