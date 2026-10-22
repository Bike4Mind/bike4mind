import { runApiKeyBaselineCalculation } from '@workers/cron/apiKeyBaselineCalculation';
import type { SelfHostWorker } from './selfHostWorker';

export function registerApiKeyBaselineCalculation(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  worker.registerDailyUtcTask('apiKeyBaselineCalculation', 2, async () => {
    const result = await runApiKeyBaselineCalculation();
    if (result.errors > 0) throw new Error(`API key baseline calculation failed for ${result.errors} key(s)`);
  });
}
