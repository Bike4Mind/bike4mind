import { allSecrets } from './secrets';
import { websocketApi } from './websocket';
import { DEFAULT_LAMBDA_ENVIRONMENT, SINGLE_RECORD_BATCH, isPreviewStage } from './constants';
import { subscribeUnlessPreview } from './previewQueueConsumers';
import { lambdaVpc } from './vpc';
import { eventBus } from './bus';
import { appUrlForLambdaEnv } from './router';
import { appFilesBucket } from './buckets';
import { mailBodyEnvironment, mailBodyPutPermission } from './mailBodyOffload';

/**
 * Email Marketing Infrastructure
 *
 * Queue-based batch processing for marketing emails:
 * - emailJobQueue: Receives job start events, fans out to batch queue
 * - emailBatchQueue: Processes batches of 16 recipients
 */

// Dead Letter Queue for failed email batches
const emailBatchQueueDLQ = new sst.aws.Queue('emailBatchQueueDLQ', {});

// Main batch processing queue
export const emailBatchQueue = new sst.aws.Queue('emailBatchQueue', {
  // At least the Lambda timeout plus SEND_LEASE_MS (apps/workers/src/queueHandlers/emailBatch.ts), so a
  // redelivery after a timed-out invocation finds every lease it took already stale.
  visibilityTimeout: '5 minutes',
  dlq: {
    queue: emailBatchQueueDLQ.arn,
    retry: 3,
  },
});

// Subscribe Lambda to process email batches
export const emailBatchQueueSubscription = subscribeUnlessPreview(
  isPreviewStage,
  'emailBatchQueue',
  emailBatchQueue,
  {
    handler: 'apps/workers/src/queueHandlers/emailBatch.dispatch',
    timeout: '2 minutes',
    memory: '512 MB',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, eventBus],
    environment: {
      ...mailBodyEnvironment(appFilesBucket),
      ...DEFAULT_LAMBDA_ENVIRONMENT,
      // APP_URL is needed for tracking links in emails
      APP_URL: $dev ? 'http://localhost:3000' : appUrlForLambdaEnv(),
    },
    permissions: [mailBodyPutPermission(appFilesBucket)],
  },
  {
    // Handler already loops event.Records; report per-record failures instead of
    // swallowing them so a transient failure is retried/DLQ'd instead of silently acked.
    batch: { partialResponses: true },
  }
);

// Dead Letter Queue for failed job orchestration
const emailJobQueueDLQ = new sst.aws.Queue('emailJobQueueDLQ', {});

// Job orchestration queue (fans out to batch queue)
export const emailJobQueue = new sst.aws.Queue('emailJobQueue', {
  visibilityTimeout: '10 minutes', // Time to fan out all batches
  dlq: {
    queue: emailJobQueueDLQ.arn,
    retry: 3,
  },
});

export const emailJobQueueSubscription = subscribeUnlessPreview(
  isPreviewStage,
  'emailJobQueue',
  emailJobQueue,
  {
    handler: 'apps/workers/src/queueHandlers/emailJobOrchestrator.dispatch',
    timeout: '5 minutes',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, emailBatchQueue, eventBus],
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
  SINGLE_RECORD_BATCH
);

export { emailBatchQueueDLQ, emailJobQueueDLQ };
