import { allSecrets } from './secrets';
import { websocketApi } from './websocket';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { lambdaVpc } from './vpc';
import { eventBus } from './bus';
import { router } from './router';

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
  visibilityTimeout: '3 minutes', // Time to process 16 emails
  dlq: {
    queue: emailBatchQueueDLQ.arn,
    retry: 3,
  },
});

// Subscribe Lambda to process email batches
export const emailBatchQueueSubscription = emailBatchQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/emailBatch.dispatch',
    timeout: '2 minutes',
    memory: '512 MB',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, eventBus],
    logging: {
      retention: '1 week',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
      // APP_URL is needed for tracking links in emails
      APP_URL: $dev ? 'http://localhost:3000' : router.url,
    },
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

export const emailJobQueueSubscription = emailJobQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/emailJobOrchestrator.dispatch',
    timeout: '5 minutes',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, emailBatchQueue, eventBus],
    logging: {
      retention: '1 week',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
  {
    // Handler is single-record (reads event.Records[0]); pin batch size to 1 so
    // multi-record deliveries can't silently drop the un-read records. Matches
    // sreJobQueue / overwatchAnalyticsQueue in queues.ts.
    batch: { size: 1 },
  }
);

export { emailBatchQueueDLQ, emailJobQueueDLQ };
