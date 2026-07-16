import {
  appFilesBucket,
  fabFileBucket,
  generatedImagesBucket,
  slackExportBucket,
  whatsNewDistributionBucket,
} from './buckets';
import { DEFAULT_LAMBDA_ENVIRONMENT, PRODUCTION_STAGES, SINGLE_RECORD_BATCH } from './constants';
import { imageProcessor } from './imageProcessor';
import { allSecrets } from './secrets';
import { websocketApi } from './websocket';
import { lambdaVpc } from './vpc';
import { eventBus } from './bus';
import { mcpHandler } from './mcp';
import { router, whatsNewDistributionId } from './router';

// FabFile Vectorize Queue
const fabFileVectorizeQueueDLQ = new sst.aws.Queue('fabFileVectorizeQueueDLQ', {});
const fabFileVectorizeQueue = new sst.aws.Queue('fabFileVectorizeQueue', {
  visibilityTimeout: '6 minutes',
  dlq: {
    queue: fabFileVectorizeQueueDLQ.arn,
    retry: 3,
  },
});
const fabFileVectorizeQueueSubscription = fabFileVectorizeQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/fabFileVectorize.dispatch',
    runtime: 'nodejs24.x',
    timeout: '5 minutes',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, fabFileBucket, generatedImagesBucket, appFilesBucket],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      },
    ],
    // Only set reserved concurrency on production/dev to avoid exhausting account limits on PR stages
    concurrency: ['production', 'dev'].includes($app.stage)
      ? {
          // Limit concurrency to prevent rate limit spikes
          // Max 10 concurrent Lambda executions = max ~10-20 parallel embedding API calls
          // Queue will buffer excess load automatically
          reserved: 10,
        }
      : undefined,
    copyFiles: [
      {
        from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
        to: 'tiktoken_bg.wasm',
      },
    ],
  },
  {
    // Handler is single-record (reads event.Records[0]); pin batch size to 1 so
    // multi-record deliveries can't silently drop the un-read records. Matches
    // sreJobQueue / overwatchAnalyticsQueue below.
    batch: { size: 1 },
  }
);

// FabFile Chunk Queue
const fabFileChunkQueueDLQ = new sst.aws.Queue('fabFileChunkQueueDLQ', {});
const fabFileChunkQueue = new sst.aws.Queue('fabFileChunkQueue', {
  visibilityTimeout: '60 minutes',
  dlq: {
    queue: fabFileChunkQueueDLQ.arn,
    retry: 3,
  },
});
const fabFileChunkQueueSubscription = fabFileChunkQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/fabFileChunk.dispatch',
    runtime: 'nodejs24.x',
    timeout: '13 minutes',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, fabFileVectorizeQueue, fabFileBucket, generatedImagesBucket, appFilesBucket],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    copyFiles: [
      {
        from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
        to: 'tiktoken_bg.wasm',
      },
    ],
  },
  {
    // Handler is single-record (reads event.Records[0]); pin batch size to 1 so
    // multi-record deliveries can't silently drop the un-read records. Matches
    // sreJobQueue / overwatchAnalyticsQueue below.
    batch: { size: 1 },
  }
);

// FabFile Moderation DLQ — this Lambda is invoked directly and asynchronously by S3
// (bucket.notify(), not an sst.aws.Queue subscription), so failure visibility can't use
// the `queue.subscribe()` dlq/retry pattern used everywhere else in this file. Instead we
// attach this queue as the Lambda's native async-invocation dead-letter target via
// `transform.function.deadLetterConfig` below: after Lambda's built-in async retries
// (2 retries) are exhausted, it writes the original S3 event payload here so a transient
// Rekognition/moderation failure is no longer silently dropped.
const fabFileModerationDLQ = new sst.aws.Queue('fabFileModerationDLQ', {});
const fabFileBucketNotification = fabFileBucket.notify({
  notifications: [
    {
      name: 'uploadComplete',
      function: {
        handler: 'apps/client/server/s3/objectCreated.func',
        runtime: 'nodejs24.x',
        link: [...allSecrets, websocketApi, fabFileChunkQueue, fabFileBucket],
        permissions: [
          { actions: ['rekognition:DetectModerationLabels'], resources: ['*'] },
          // Required for Lambda's async-invoke failure mechanism to deliver the failed
          // event to the DLQ — AWS Lambda uses the function's own execution role to send.
          { actions: ['sqs:SendMessage'], resources: [fabFileModerationDLQ.arn] },
        ],
        vpc: lambdaVpc,
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
        logging: {
          retention: '3 days',
        },
        transform: {
          // sst.aws.Function has no first-party `dlq`/destinations prop for async invoke
          // failures (unlike sst.aws.Cron's `dlq`), so the underlying aws.lambda.Function's
          // native deadLetterConfig is set directly via transform.function.
          function: {
            deadLetterConfig: {
              targetArn: fabFileModerationDLQ.arn,
            },
          },
        },
      },
      events: ['s3:ObjectCreated:*'],
    },
  ],
});

// Image Generation Queue
const imageGenerationDLQ = new sst.aws.Queue('imageGenerationDLQ', {});
const imageGenerationQueue = new sst.aws.Queue('imageGenerationQueue', {
  visibilityTimeout: '11 minutes',
  dlq: {
    queue: imageGenerationDLQ.arn,
    retry: 3,
  },
});
const imageGenerationQueueSubscription = imageGenerationQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/imageGeneration.dispatch',
    runtime: 'nodejs24.x',
    timeout: '10 minutes',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, generatedImagesBucket, fabFileBucket, appFilesBucket, imageProcessor, eventBus],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
      {
        actions: ['rekognition:DetectModerationLabels'],
        resources: ['*'],
      },
    ],
    copyFiles: [
      {
        from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
        to: 'tiktoken_bg.wasm',
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

// Image Edit Queue
const imageEditDLQ = new sst.aws.Queue('imageEditDLQ', {});
const imageEditQueue = new sst.aws.Queue('imageEditQueue', {
  visibilityTimeout: '11 minutes',
  dlq: {
    queue: imageEditDLQ.arn,
    retry: 3,
  },
});
const imageEditQueueSubscription = imageEditQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/imageEdit.dispatch',
    runtime: 'nodejs24.x',
    timeout: '10 minutes',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, generatedImagesBucket, fabFileBucket, appFilesBucket, imageProcessor],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
      {
        actions: ['rekognition:DetectModerationLabels'],
        resources: ['*'],
      },
    ],
    copyFiles: [
      {
        from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
        to: 'tiktoken_bg.wasm',
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

const researchEngineQueueDLQ = new sst.aws.Queue('researchEngineQueueDLQ', {});
const researchEngineQueue = new sst.aws.Queue('researchEngineQueue', {
  visibilityTimeout: '15 minutes',
  dlq: {
    queue: researchEngineQueueDLQ.arn,
    retry: 3,
  },
});

const researchEngineQueueSubscription = researchEngineQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/researchEngineQueue.dispatch',
    runtime: 'nodejs24.x',
    vpc: lambdaVpc,
    timeout: '15 minutes',
    link: [...allSecrets, fabFileBucket, websocketApi, generatedImagesBucket, researchEngineQueue],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
    ],
    copyFiles: [
      {
        from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
        to: 'tiktoken_bg.wasm',
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

// What's New Modal Generation Queue
const whatsNewGenerationQueueDLQ = new sst.aws.Queue('whatsNewGenerationQueueDLQ', {
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Enable SQS encryption
      messageRetentionSeconds: 1209600, // 14 days - extended retention for forensics investigation
    },
  },
});
const whatsNewGenerationQueue = new sst.aws.Queue('whatsNewGenerationQueue', {
  visibilityTimeout: '8 minutes', // 3-minute safety margin over Lambda 5-min timeout
  dlq: {
    queue: whatsNewGenerationQueueDLQ.arn,
    retry: 3,
  },
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Enable SQS encryption
    },
  },
});
const whatsNewGenerationQueueSubscription = whatsNewGenerationQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/whatsNewGeneration.dispatch',
    timeout: '5 minutes',
    vpc: lambdaVpc,
    link: [
      ...allSecrets,
      websocketApi,
      ...(whatsNewDistributionBucket ? [whatsNewDistributionBucket] : []),
      ...(whatsNewDistributionId ? [whatsNewDistributionId] : []),
    ],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          'arn:aws:bedrock:*:*:foundation-model/anthropic.claude-*',
          'arn:aws:bedrock:*:*:foundation-model/amazon.*',
          'arn:aws:bedrock:*:*:inference-profile/anthropic.claude-*',
          'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-*',
          'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-*',
        ],
      },
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
      {
        // CloudFront cache invalidation for What's New modal distribution
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          $interpolate`arn:aws:cloudfront::${aws.getCallerIdentityOutput().accountId}:distribution/${router.distributionID}`,
        ],
      },
    ],
    copyFiles: [
      {
        from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
        to: 'tiktoken_bg.wasm',
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

// Notebook Curation Queue
const notebookCurationQueueDLQ = new sst.aws.Queue('notebookCurationQueueDLQ', {});
const notebookCurationQueue = new sst.aws.Queue('notebookCurationQueue', {
  visibilityTimeout: '15 minutes',
  dlq: {
    queue: notebookCurationQueueDLQ.arn,
    retry: 3,
  },
});
const notebookCurationQueueSubscription = notebookCurationQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/notebookCuration.dispatch',
    runtime: 'nodejs24.x',
    timeout: '10 minutes',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, eventBus, fabFileBucket, generatedImagesBucket, appFilesBucket],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

// Agent Proactive Message Queue
const agentProactiveMessageQueueDLQ = new sst.aws.Queue('agentProactiveMessageQueueDLQ', {});
const agentProactiveMessageQueue = new sst.aws.Queue('agentProactiveMessageQueue', {
  visibilityTimeout: '11 minutes',
  dlq: {
    queue: agentProactiveMessageQueueDLQ.arn,
    retry: 3,
  },
});
const agentProactiveMessageQueueSubscription = agentProactiveMessageQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/agentProactiveMessage.dispatch',
    runtime: 'nodejs24.x',
    timeout: '10 minutes',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, fabFileBucket, generatedImagesBucket, appFilesBucket],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
      // This handler wires imageGenerateStorage and runs image_generation/edit_image tools
      // (closes an agent-tool moderation bypass).
      {
        actions: ['rekognition:DetectModerationLabels'],
        resources: ['*'],
      },
    ],
    copyFiles: [
      {
        from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
        to: 'tiktoken_bg.wasm',
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

// GitHub Webhook Processing Queue
// Handles async processing of GitHub webhook events
const githubWebhookQueueDLQ = new sst.aws.Queue('githubWebhookQueueDLQ', {
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Encrypt webhook payloads (may contain sensitive GitHub data)
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});
const githubWebhookQueue = new sst.aws.Queue('githubWebhookQueue', {
  visibilityTimeout: '5 minutes', // Handler timeout (1 min) + safety margin for cold starts/clock skew
  dlq: {
    queue: githubWebhookQueueDLQ.arn,
    retry: 3,
  },
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Encrypt webhook payloads
    },
  },
});
const githubWebhookQueueSubscription = githubWebhookQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/githubWebhook.dispatch',
    runtime: 'nodejs24.x',
    timeout: '1 minute', // Fast processing for webhooks
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, fabFileBucket, generatedImagesBucket, appFilesBucket, mcpHandler],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
        resources: [githubWebhookQueue.arn],
      },
    ],
    // Only set reserved concurrency on production/dev to avoid exhausting account limits on PR stages
    concurrency: ['production', 'dev'].includes($app.stage)
      ? {
          // Limit concurrency to prevent unbounded executions during webhook storms
          // Max 10 concurrent Lambda executions - queue will buffer excess load
          reserved: 10,
        }
      : undefined,
  },
  SINGLE_RECORD_BATCH
);

// Webhook Delivery Queue
// Handles async HTTP delivery of webhooks to subscriber endpoints with retry logic
const webhookDeliveryQueueDLQ = new sst.aws.Queue('webhookDeliveryQueueDLQ', {
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Encrypt payloads (contains user webhook data)
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});
const webhookDeliveryQueue = new sst.aws.Queue('webhookDeliveryQueue', {
  visibilityTimeout: '2 minutes', // 30s Lambda timeout + safety margin for retries
  dlq: {
    queue: webhookDeliveryQueueDLQ.arn,
    retry: 5, // Industry standard: 5 retries with exponential backoff
  },
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Encrypt webhook payloads
    },
  },
});
const webhookDeliveryQueueSubscription = webhookDeliveryQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/webhookDelivery.dispatch',
    runtime: 'nodejs24.x',
    timeout: '30 seconds', // HTTP delivery timeout (10s per attempt + overhead)
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi],
    logging: {
      retention: '1 week', // Extended retention for delivery debugging
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
    // Higher throughput for webhook delivery - 20 concurrent Lambda executions
    concurrency: ['production', 'dev'].includes($app.stage)
      ? {
          reserved: 20,
        }
      : undefined,
  },
  SINGLE_RECORD_BATCH
);

// Slack Export Queue
// Handles async export of large Slack channels to S3
const slackExportQueueDLQ = new sst.aws.Queue('slackExportQueueDLQ', {
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for debugging failed exports
    },
  },
});
const slackExportQueue = new sst.aws.Queue('slackExportQueue', {
  visibilityTimeout: '16 minutes', // 1 minute buffer over Lambda timeout
  dlq: {
    queue: slackExportQueueDLQ.arn,
    retry: 2, // Only retry twice - exports are expensive
  },
});
const slackExportQueueSubscription = slackExportQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/slackExport.dispatch',
    runtime: 'nodejs24.x',
    timeout: '15 minutes', // Maximum Lambda timeout for large exports
    memory: '1024 MB', // More memory for processing large message sets
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, slackExportBucket],
    logging: {
      retention: '1 week', // Longer retention for export debugging
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    // Only set reserved concurrency on production/dev to avoid exhausting account limits on PR stages
    concurrency: ['production', 'dev'].includes($app.stage)
      ? {
          // Limit concurrency to prevent Slack rate limit issues
          // Max 5 concurrent exports = manageable API load
          reserved: 5,
        }
      : undefined,
  },
  SINGLE_RECORD_BATCH
);

// Quest Export Queue
// Handles async export of QuestMaster plans to ZIP (markdown + images)
const questExportQueueDLQ = new sst.aws.Queue('questExportQueueDLQ', {});
const questExportQueue = new sst.aws.Queue('questExportQueue', {
  visibilityTimeout: '11 minutes',
  dlq: {
    queue: questExportQueueDLQ.arn,
    retry: 2,
  },
});
const questExportQueueSubscription = questExportQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/questExport.dispatch',
    runtime: 'nodejs24.x',
    timeout: '10 minutes',
    memory: '1024 MB',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, fabFileBucket, generatedImagesBucket, appFilesBucket],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

// What's New Highlights Queue
// Generates weekly highlights summary from What's New modals and posts to Slack
const whatsNewHighlightsQueueDLQ = new sst.aws.Queue('whatsNewHighlightsQueueDLQ', {
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Enable SQS encryption
      messageRetentionSeconds: 1209600, // 14 days for debugging
    },
  },
});
const whatsNewHighlightsQueue = new sst.aws.Queue('whatsNewHighlightsQueue', {
  visibilityTimeout: '8 minutes', // 3-minute safety margin over Lambda 5-min timeout
  dlq: {
    queue: whatsNewHighlightsQueueDLQ.arn,
    retry: 3,
  },
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Enable SQS encryption
    },
  },
});
const whatsNewHighlightsQueueSubscription = whatsNewHighlightsQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/whatsNewHighlights.dispatch',
    timeout: '5 minutes',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          'arn:aws:bedrock:*:*:foundation-model/anthropic.claude-*',
          'arn:aws:bedrock:*:*:foundation-model/amazon.*',
          'arn:aws:bedrock:*:*:inference-profile/anthropic.claude-*',
          'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-*',
          'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-*',
        ],
      },
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
    copyFiles: [
      {
        from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
        to: 'tiktoken_bg.wasm',
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

// Video Generation Queue
// Handles async OpenAI Sora video generation (longer processing times)
// Note: Lambda max timeout is 15 minutes. The Sora polling happens within the Lambda,
// so we set to max Lambda timeout. If videos take longer, the polling will timeout
// and the job may need to be retried or handled differently in the future.
const videoGenerationDLQ = new sst.aws.Queue('videoGenerationDLQ', {});
const videoGenerationQueue = new sst.aws.Queue('videoGenerationQueue', {
  visibilityTimeout: '20 minutes', // Lambda timeout (15 min) + safety margin
  dlq: {
    queue: videoGenerationDLQ.arn,
    retry: 2, // Fewer retries - video generation is expensive
  },
});
const videoGenerationQueueSubscription = videoGenerationQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/videoGeneration.dispatch',
    runtime: 'nodejs24.x',
    timeout: '15 minutes', // Max Lambda timeout (900 seconds)
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, generatedImagesBucket, fabFileBucket, appFilesBucket, eventBus],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    concurrency: {
      // Limit concurrency - video generation is resource-intensive
      reserved: 5,
    },
  },
  SINGLE_RECORD_BATCH
);

// LiveOps Triage Queue (Multi-Config)
// Handles triage jobs dispatched by liveopsTriageDispatcher.
// Each message contains a configId for independent processing.
const liveOpsTriageQueueDLQ = new sst.aws.Queue('liveOpsTriageQueueDLQ', {
  visibilityTimeout: '10 minutes',
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for forensics
    },
  },
});
const liveOpsTriageQueue = new sst.aws.Queue('liveOpsTriageQueue', {
  visibilityTimeout: '8 minutes', // Lambda timeout (5 min) + 3 min safety buffer
  dlq: {
    queue: liveOpsTriageQueueDLQ.arn,
    retry: 2, // Retry twice to handle transient failures
  },
});
const liveOpsTriageQueueSubscription = liveOpsTriageQueue.subscribe(
  {
    handler: 'apps/client/server/cron/liveopsTriageWorker.handler',
    runtime: 'nodejs24.x',
    timeout: '5 minutes',
    memory: '512 MB',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi, fabFileBucket, generatedImagesBucket, appFilesBucket, eventBus, mcpHandler],
    logging: {
      retention: '1 week', // Extended retention for debugging
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

// SecOps Triage Queue
// Receives full ZAP scan payloads (including instances/URLs/evidence) fanned out
// from the web-owasp-ingest endpoint. Creates/updates GitHub issues via b4m-prod App.
// Encrypted: payload contains security-sensitive URLs and vulnerability evidence.
const secopsTriageQueueDLQ = new sst.aws.Queue('secopsTriageQueueDLQ', {
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Encrypt security finding payloads
      messageRetentionSeconds: 1209600, // 14 days for forensics
    },
  },
});
const secopsTriageQueue = new sst.aws.Queue('secopsTriageQueue', {
  visibilityTimeout: '8 minutes', // Lambda timeout (5 min) + 3 min safety buffer
  dlq: {
    queue: secopsTriageQueueDLQ.arn,
    retry: 2,
  },
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Encrypt security finding payloads
    },
  },
});

const secopsTriageQueueSubscription = secopsTriageQueue.subscribe(
  {
    handler: 'apps/client/server/cron/secopsTriageWorker.handler',
    runtime: 'nodejs24.x',
    timeout: '5 minutes',
    memory: '512 MB',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi],
    logging: {
      retention: '1 week',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
    // Only set reserved concurrency on production/dev — ZAP scans are weekly, low volume
    concurrency: ['production', 'dev'].includes($app.stage)
      ? {
          reserved: 2,
        }
      : undefined,
  },
  SINGLE_RECORD_BATCH
);

// Tavern Heartbeat Queue + DLQ
// These stay in core so that infra/web.ts Linkables and infra/dlqAlarms.ts can import
// them at module-level. The subscription (Lambda handler) moves to @bike4mind/premium-tavern
// contributeInfra() with an updated handler path pointing to the generated stub.
const tavernHeartbeatQueueDLQ = new sst.aws.Queue('tavernHeartbeatQueueDLQ', {});
const tavernHeartbeatQueue = new sst.aws.Queue('tavernHeartbeatQueue', {
  visibilityTimeout: '8 minutes',
  dlq: {
    queue: tavernHeartbeatQueueDLQ.arn,
    retry: 2,
  },
});

// Deep Agent Wake Queue
// One message → one wake cycle for one long-horizon agent (orient → act →
// reflect → groom). See apps/client/server/deepAgent and
// docs/concepts/deep-agent-framework.md.
const deepAgentWakeQueueDLQ = new sst.aws.Queue('deepAgentWakeQueueDLQ', {});
const deepAgentWakeQueue = new sst.aws.Queue('deepAgentWakeQueue', {
  visibilityTimeout: '12 minutes',
  dlq: {
    queue: deepAgentWakeQueueDLQ.arn,
    retry: 2,
  },
});
const deepAgentWakeQueueSubscription = deepAgentWakeQueue.subscribe(
  {
    handler: 'apps/client/server/deepAgent/wakeHandler.dispatch',
    runtime: 'nodejs24.x',
    timeout: '10 minutes',
    vpc: lambdaVpc,
    link: [...allSecrets],
    logging: {
      retention: '3 days',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      },
      // deepAgent/toolMaterializer.ts wires imageGenerateStorage and runs image_generation/
      // edit_image tools (closes an agent-tool moderation bypass).
      {
        actions: ['rekognition:DetectModerationLabels'],
        resources: ['*'],
      },
    ],
    copyFiles: [
      {
        from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
        to: 'tiktoken_bg.wasm',
      },
    ],
  },
  SINGLE_RECORD_BATCH
);

// SRE Fix Queue (defined before the SRE Job Queue because the Diagnostician dispatches to it)
// Dispatches repository_dispatch events to trigger GitHub Actions autofix workflow.
// Kept separate from the merged Job Queue — different retry policy/timeout and a
// downstream dispatch target (#8657).
const sreFixQueueDLQ = new sst.aws.Queue('sreFixQueueDLQ', {});
const sreFixQueue = new sst.aws.Queue('sreFixQueue', {
  visibilityTimeout: '5 minutes',
  dlq: {
    queue: sreFixQueueDLQ.arn,
    retry: 2,
  },
});
const sreFixQueueSubscription = sreFixQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/sreFix.dispatch',
    runtime: 'nodejs24.x',
    timeout: '2 minutes',
    memory: '256 MB',
    vpc: lambdaVpc,
    link: [...allSecrets],
    logging: {
      retention: '1 week',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
      APP_URL: $dev ? 'http://localhost:3000' : router.url,
    },
  },
  SINGLE_RECORD_BATCH
);

// SRE Job Queue (merged Analysis + Revision — #8657)
// Single queue for both analysis and revision jobs, discriminated by a `jobType`
// field on the message body. Analysis and revision share consumer profile (8-min
// timeout, 1024 MB, Bedrock + CloudWatch) and retry policy (retry 3), so they
// collapse into one queue + one handler. The Fix queue stays separate — it is a
// downstream dispatch target with a different retry policy and timeout.
//
// Replaced the former sreAnalysisQueue + sreRevisionQueue, which are removed in this
// same change. Deploy note: this rename is destroy-old + create-new, so any messages
// in flight on the old queues at cutover are dropped. Accepted because the SRE pipeline
// is low volume and self-healing (the rerun/retry endpoints re-enqueue) — deploy during
// a quiet window. For zero-loss, ship this queue first and drain the old ones before
// removing them. See PR #8657 "Additional Information".
const sreJobQueueDLQ = new sst.aws.Queue('sreJobQueueDLQ', {
  visibilityTimeout: '10 minutes',
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for forensics
      kmsMasterKeyId: 'alias/aws/sqs', // Encrypt forensic payloads (error messages, stack traces)
    },
  },
});
const sreJobQueue = new sst.aws.Queue('sreJobQueue', {
  visibilityTimeout: '10 minutes', // Lambda timeout (8 min) + 2 min safety buffer
  dlq: {
    queue: sreJobQueueDLQ.arn,
    retry: 3,
  },
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs', // Encrypt payloads (error messages, stack traces)
    },
  },
});
const sreJobQueueSubscription = sreJobQueue.subscribe(
  {
    handler: 'apps/client/server/queueHandlers/sreJob.dispatch',
    runtime: 'nodejs24.x',
    timeout: '8 minutes',
    memory: '1024 MB',
    vpc: lambdaVpc,
    // eventBus: analysis emits sre.analysis.completed (routed to sreFixQueue by
    // infra/eventBus.ts). sreFixQueue stays linked for the revision path's direct dispatch.
    link: [...allSecrets, websocketApi, sreFixQueue, eventBus],
    logging: {
      retention: '1 week',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      },
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
    ],
    copyFiles: [
      {
        from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
        to: 'tiktoken_bg.wasm',
      },
    ],
    // reserved: 4 preserves the pre-merge aggregate capacity (analysis had 2 +
    // revision had 2). Note: this is now a single shared pool, NOT a per-stage
    // partition — a sustained analysis burst can consume all 4 slots and delay
    // revisions until visibility timeouts roll. Acceptable given low SRE volume;
    // raise this if revision latency suffers under co-tenancy.
    concurrency: ['production', 'dev'].includes($app.stage)
      ? {
          reserved: 4,
        }
      : undefined,
  },
  {
    // One message per invocation: each SRE job is an independent, long-running
    // (up to 8-min) LLM task, and the handler processes event.Records[0]. Making
    // size:1 explicit so multi-record batches can't silently drop records.
    batch: { size: 1 },
  }
);

// ---------------------------------------------------------------------------
// Overwatch Analytics Queue — receives product events for DAU/WAU/MAU tracking
// ---------------------------------------------------------------------------

const overwatchAnalyticsQueueDLQ = new sst.aws.Queue('overwatchAnalyticsQueueDLQ', {
  transform: {
    queue: { messageRetentionSeconds: 1209600, kmsMasterKeyId: 'alias/aws/sqs' }, // 14 days, KMS encrypted
  },
});

const overwatchAnalyticsQueue = new sst.aws.Queue('overwatchAnalyticsQueue', {
  visibilityTimeout: '3 minutes', // 6× Lambda timeout (30s) per AWS best practice
  dlq: {
    queue: overwatchAnalyticsQueueDLQ.arn,
    retry: 3,
  },
  transform: {
    // SSE-SQS (not SSE-KMS): alias/aws/sqs is an AWS-managed key whose key policy cannot
    // be modified to allow cross-account access. SSE-SQS is transparent to cross-account
    // producers — they need only sqs:SendMessage. DLQ retains KMS (intra-account only).
    queue: { sqsManagedSseEnabled: true },
  },
});

// Allow cross-account sqs:SendMessage from external producer accounts (e.g. VibesWire,
// K2Kanji, StocksAndVibes). The account IDs are deployment-specific, so they come from
// the OVERWATCH_ANALYTICS_CROSS_ACCOUNT_IDS env var (comma-separated 12-digit IDs) with
// no brand fallback — when unset/all-invalid, no cross-account policy is created. Entries
// are validated as exactly 12 digits so a typo can't mint a malformed principal ARN.
const overwatchCrossAccountIds = (process.env.OVERWATCH_ANALYTICS_CROSS_ACCOUNT_IDS ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(id => /^\d{12}$/.test(id));
// Loud guard: on a persistent stage, an empty list means this deploy will NOT create the
// policy — and Pulumi will DESTROY any existing one, silently revoking cross-account
// sqs:SendMessage (e.g. VibesWire). Warn at synth so a missing/renamed/mis-scoped var is
// visible in the deploy log instead of quietly dropping access.
if (overwatchCrossAccountIds.length === 0 && PRODUCTION_STAGES.includes($app.stage)) {
  console.warn(
    `⚠️  OVERWATCH_ANALYTICS_CROSS_ACCOUNT_IDS is empty on stage '${$app.stage}'. ` +
      `overwatchAnalyticsQueuePolicy will not be created; any existing cross-account ` +
      `sqs:SendMessage grant will be REMOVED on this deploy. Set the repo/org variable ` +
      `if external producers should retain access.`
  );
}
if (overwatchCrossAccountIds.length > 0) {
  new aws.sqs.QueuePolicy('overwatchAnalyticsQueuePolicy', {
    queueUrl: overwatchAnalyticsQueue.url,
    policy: overwatchAnalyticsQueue.arn.apply(arn =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowCrossAccountSendMessage',
            Effect: 'Allow',
            Principal: {
              AWS: overwatchCrossAccountIds.map(id => `arn:aws:iam::${id}:root`),
            },
            Action: 'sqs:SendMessage',
            Resource: arn,
            Condition: { Bool: { 'aws:SecureTransport': 'true' } },
          },
        ],
      })
    ),
  });
}

const overwatchAnalyticsQueueSubscription = overwatchAnalyticsQueue.subscribe(
  {
    handler: 'apps/client/server/premium-generated/queueHandlers/overwatchAnalytics.dispatch',
    runtime: 'nodejs24.x',
    timeout: '30 seconds',
    memory: '256 MB',
    vpc: lambdaVpc,
    link: [...allSecrets, websocketApi],
    logging: { retention: '3 days' },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [{ actions: ['cloudwatch:PutMetricData'], resources: ['*'] }],
    // Only set reserved concurrency on production/dev to avoid exhausting account limits on PR stages.
    // `concurrency` belongs on the subscriber's function args (1st arg), not the
    // subscriber options (2nd arg, QueueSubscriberArgs), which has no such field.
    concurrency: ['production', 'dev'].includes($app.stage) ? { reserved: 10 } : undefined,
  },
  {
    batch: { size: 1 },
  }
);

// Agent Continuation Queue (self-dispatch)
//
// Enables Lambda self-dispatch for agent executions that exceed Lambda's 15-minute timeout.
// When the iteration loop detects the deadline approaching, it:
//   1. Checkpoints agent state (messages, token counters, steps) to MongoDB
//   2. Publishes a continuation message to this queue with `checkpointDepth` incremented
//   3. A new Lambda invocation CAS-claims the execution and resumes from the checkpoint
//
// Self-dispatch safety constraints (see agentExecutor.ts for constants):
//   - CHECKPOINT_DEPTH_WARNING = 25: emits `CheckpointDepthWarning` metric to catch runaway agents early
//   - MAX_CHECKPOINT_DEPTH    = 50: hard ceiling; Lambda refuses to process and marks the execution failed
//
// Message schema: { kind: 'continuation', executionId, connectionId, checkpointDepth }
// Handler:        apps/client/server/queueHandlers/agentExecutor.ts → processExecution()
const agentContinuationQueueDLQ = new sst.aws.Queue('agentContinuationQueueDLQ', {
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs',
    },
  },
});
const agentContinuationQueue = new sst.aws.Queue('agentContinuationQueue', {
  visibilityTimeout: '16 minutes', // > 15min Lambda timeout
  dlq: {
    queue: agentContinuationQueueDLQ.arn,
    retry: 3,
  },
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs',
    },
  },
});

// NOTE: The agentContinuationQueue subscription is set up in infra/agentExecutor.ts
// where the Agent Executor Lambda is defined, since it needs a reference to that Lambda.

// OptiHashi Run Completion Queue
// Handles async credit settlement when OptiHashi reports run completion/failure
const optihashiRunCompletionQueueDLQ = new sst.aws.Queue('optihashiRunCompletionQueueDLQ', {
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs',
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});
const optihashiRunCompletionQueue = new sst.aws.Queue('optihashiRunCompletionQueue', {
  visibilityTimeout: '24 minutes', // ≥ 6× handler timeout (4 min) per AWS recommendation
  dlq: {
    queue: optihashiRunCompletionQueueDLQ.arn,
    retry: 3,
  },
  transform: {
    queue: {
      kmsMasterKeyId: 'alias/aws/sqs',
    },
  },
});
const optihashiRunCompletionQueueSubscription = optihashiRunCompletionQueue.subscribe({
  handler: 'apps/client/server/premium-generated/optihashiRunCompletion.dispatch',
  runtime: 'nodejs24.x',
  timeout: '4 minutes',
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  logging: {
    retention: '3 days',
  },
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    { actions: ['cloudwatch:PutMetricData'], resources: ['*'] },
    { actions: ['execute-api:ManageConnections'], resources: ['*'] },
  ],
});

export {
  // Queues
  fabFileChunkQueue,
  fabFileVectorizeQueue,
  imageGenerationQueue,
  imageEditQueue,
  videoGenerationQueue,
  researchEngineQueue,
  whatsNewGenerationQueue,
  whatsNewHighlightsQueue,
  notebookCurationQueue,
  agentProactiveMessageQueue,
  slackExportQueue,
  githubWebhookQueue,
  webhookDeliveryQueue,
  questExportQueue,
  liveOpsTriageQueue,
  tavernHeartbeatQueue,
  deepAgentWakeQueue,
  sreFixQueue,
  sreJobQueue,
  secopsTriageQueue,
  agentContinuationQueue,
  optihashiRunCompletionQueue,
  // DLQs
  fabFileChunkQueueDLQ,
  fabFileVectorizeQueueDLQ,
  fabFileModerationDLQ,
  imageGenerationDLQ,
  imageEditDLQ,
  videoGenerationDLQ,
  researchEngineQueueDLQ,
  whatsNewGenerationQueueDLQ,
  whatsNewHighlightsQueueDLQ,
  notebookCurationQueueDLQ,
  agentProactiveMessageQueueDLQ,
  slackExportQueueDLQ,
  githubWebhookQueueDLQ,
  webhookDeliveryQueueDLQ,
  questExportQueueDLQ,
  liveOpsTriageQueueDLQ,
  tavernHeartbeatQueueDLQ,
  deepAgentWakeQueueDLQ,
  sreFixQueueDLQ,
  sreJobQueueDLQ,
  secopsTriageQueueDLQ,
  overwatchAnalyticsQueue,
  overwatchAnalyticsQueueDLQ,
  agentContinuationQueueDLQ,
  optihashiRunCompletionQueueDLQ,
  // Subscriptions
  fabFileChunkQueueSubscription,
  fabFileVectorizeQueueSubscription,
  imageGenerationQueueSubscription,
  imageEditQueueSubscription,
  videoGenerationQueueSubscription,
  fabFileBucketNotification,
  researchEngineQueueSubscription,
  whatsNewGenerationQueueSubscription,
  whatsNewHighlightsQueueSubscription,
  notebookCurationQueueSubscription,
  agentProactiveMessageQueueSubscription,
  slackExportQueueSubscription,
  githubWebhookQueueSubscription,
  webhookDeliveryQueueSubscription,
  questExportQueueSubscription,
  liveOpsTriageQueueSubscription,
  deepAgentWakeQueueSubscription,
  sreFixQueueSubscription,
  sreJobQueueSubscription,
  secopsTriageQueueSubscription,
  overwatchAnalyticsQueueSubscription,
  optihashiRunCompletionQueueSubscription,
};
