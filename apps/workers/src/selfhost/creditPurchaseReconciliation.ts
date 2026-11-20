import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { runCreditPurchaseReconciliation } from '@workers/cron/creditPurchaseReconciliation';
import type { SelfHostWorker } from './selfHostWorker';

/**
 * Mirrors the hosted schedule (07:00 UTC). No-op when Stripe is unconfigured. Ungranted purchases
 * alert (logs, Slack) rather than fail the task; there is no CloudWatch on self-host.
 */
export function registerCreditPurchaseReconciliation(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  worker.registerDailyUtcTask('creditPurchaseReconciliation', 7, async () => {
    const logger = new Logger({ metadata: { service: 'creditPurchaseReconciliation', stage: Config.STAGE } });
    await runCreditPurchaseReconciliation(logger, new Date(), { stage: Config.STAGE, emitMetrics: false });
  });
}
