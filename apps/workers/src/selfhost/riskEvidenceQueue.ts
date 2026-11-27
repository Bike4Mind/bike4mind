import type { Logger } from '@bike4mind/observability';
import { dispatch } from '@workers/queueHandlers/riskEvidence';
import type { SelfHostWorker } from './selfHostWorker';

export function registerRiskEvidenceQueue(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  queueUrl: string | undefined,
  logger: Pick<Logger, 'warn'>
): void {
  if (!queueUrl) {
    logger.warn('riskEvidenceQueue not configured; account risk evidence will not be refreshed');
    return;
  }
  worker.registerQueueHandler('riskEvidenceQueue', queueUrl, dispatch, {
    batchSize: 10,
    // Exceeds the 2-minute hosted handler timeout so a slow batch is not redelivered mid-run.
    visibilityTimeoutSec: 180,
    // Matches the hosted DLQ's dlq.retry: 3.
    maxReceiveCount: 3,
  });
}
