import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { runSpendReconciliation } from '@workers/cron/spendReconciliation';
import type { SelfHostWorker } from './selfHostWorker';

/** Mirrors the hosted schedule (06:00 UTC). Each provider skips itself when its admin key is unset. */
export function registerSpendReconciliation(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  worker.registerDailyUtcTask('spendReconciliation', 6, async () => {
    const logger = new Logger({ metadata: { service: 'spendReconciliation', stage: Config.STAGE } });
    const { failed } = await runSpendReconciliation({ logger });
    if (failed > 0) throw new Error(`Spend reconciliation failed for ${failed} provider-month(s)`);
  });
}
