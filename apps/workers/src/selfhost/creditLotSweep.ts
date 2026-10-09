import { runCreditLotSweep } from '@workers/cron/creditLotSweep';
import type { SelfHostWorker } from './selfHostWorker';

export function registerCreditLotSweep(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  worker.registerDailyUtcTask('creditLotSweep', 4, async () => {
    const result = await runCreditLotSweep();
    if (result.holdersFailed > 0) throw new Error(`Credit lot sweep failed for ${result.holdersFailed} holder(s)`);
  });
}
