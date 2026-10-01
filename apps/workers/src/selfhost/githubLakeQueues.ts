import type { Context, SQSEvent } from 'aws-lambda';
import { dispatch as githubLakeIngestDispatch } from '@server/queueHandlers/githubLakeIngest';
import { dispatch as githubLakeRevokeDispatch } from '@server/queueHandlers/githubLakeRevoke';
import type { SelfHostWorker } from './selfHostWorker';

/** Hosted's 12-minute visibility for both queues (infra/queues.ts), over the handlers' 10-minute timeout. */
const GITHUB_LAKE_VISIBILITY_TIMEOUT_SEC = 720;
/** Hosted's 10-minute Lambda timeout, handed to the ingest handler as its run budget. */
const GITHUB_LAKE_INGEST_RUN_BUDGET_MS = 600_000;

/**
 * Self-host consumers for the GitHub data-lake queues, mirroring the hosted subscriptions in
 * infra/queues.ts (keep the receive counts in sync with their dlq.retry). Single-record batches
 * because the worker handles a batch sequentially under one visibility window, and both handlers
 * can run for minutes.
 */
export function registerGitHubLakeQueues(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  queueUrls: { ingest: string; revoke: string }
): void {
  worker.registerQueueHandler(
    'githubLakeIngestQueue',
    queueUrls.ingest,
    // The worker reports a day of remaining time, so without a budget a large repository would sync
    // in one run, outlive the visibility window and be redelivered mid-flight. With one, the slice
    // yields at the hosted deadline and re-enqueues itself, as it does on Lambda.
    (event: SQSEvent, context: Context) => {
      const startedAt = Date.now();
      return githubLakeIngestDispatch(event, {
        ...context,
        getRemainingTimeInMillis: () => Math.max(0, GITHUB_LAKE_INGEST_RUN_BUDGET_MS - (Date.now() - startedAt)),
      });
    },
    { batchSize: 1, visibilityTimeoutSec: GITHUB_LAKE_VISIBILITY_TIMEOUT_SEC, maxReceiveCount: 2 }
  );
  worker.registerQueueHandler('githubLakeRevokeQueue', queueUrls.revoke, githubLakeRevokeDispatch, {
    batchSize: 1,
    visibilityTimeoutSec: GITHUB_LAKE_VISIBILITY_TIMEOUT_SEC,
    // 7 receives span the ~72 minutes hosted waits for a stale sync claim to clear before giving up.
    maxReceiveCount: 7,
  });
}
