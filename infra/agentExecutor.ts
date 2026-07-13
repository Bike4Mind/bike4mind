/**
 * Agent Executor Lambda
 *
 * Dedicated Lambda for running ReActAgent on the web with:
 * - 15-minute timeout for complex multi-step executions
 * - Per-iteration checkpointing for Lambda self-dispatch
 * - Direct SDK invocation (bypasses CloudFront 20s limit)
 * - SQS-triggered resume from checkpoint for continuation
 */

import { appFilesBucket, fabFileBucket, generatedImagesBucket } from './buckets';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { eventBus } from './eventBus';
import { imageProcessor } from './imageProcessor';
import { mcpHandler } from './mcp';
import { allSecrets } from './secrets';
import { websocketApi } from './websocket';
import { lambdaVpc } from './vpc';
import { cdnUrlForLambdaEnv } from './router';
import { agentContinuationQueue } from './queues';

// Re-export websocketApi route setup for the agent_execute route.
// Defined here (not in websocket.ts) to avoid circular dependency:
// websocket.ts exports websocketApi → agentExecutor.ts imports it → no cycle.

// Both the primary Lambda and the continuation subscriber run the same handler,
// so they share runtime, VPC, links, environment, copyFiles, and IAM. Extracting
// keeps the two definitions in lockstep and prevents the "asymmetric IAM" class
// of bug (e.g., xray missing on one side) noted during review.
const SHARED_AGENT_EXECUTOR_CONFIG = {
  handler: 'apps/client/server/queueHandlers/agentExecutor.handler',
  runtime: 'nodejs24.x' as const,
  timeout: '15 minutes' as const,
  memory: '2048 MB' as const,
  vpc: lambdaVpc,
  link: [
    ...allSecrets,
    fabFileBucket,
    generatedImagesBucket,
    appFilesBucket,
    websocketApi,
    mcpHandler,
    eventBus,
    imageProcessor,
    agentContinuationQueue,
  ],
  logging: { retention: '3 days' as const },
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
    // Personal sst dev stages serve files via the local proxy (apps/client/pages/api/app-files/serve); deployed stages use the real distribution.
    NEXT_PUBLIC_CDN_URL: cdnUrlForLambdaEnv(),
  },
  permissions: [
    {
      // P2 #6: Scoped to the actual model invocation actions used by the agent —
      // wildcards would grant Bedrock admin operations the executor never needs.
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    },
    {
      // Content moderation for images produced by the image_generation/edit_image tools
      // (closes an agent-tool moderation bypass). Applies to BOTH the primary
      // AgentExecutor function and the continuation-queue subscription, since they share this
      // config object — see the note above SHARED_AGENT_EXECUTOR_CONFIG.
      actions: ['rekognition:DetectModerationLabels'],
      resources: ['*'],
    },
    {
      // P2 #7: X-Ray actions limited to what the SDK emits at runtime.
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    },
    { actions: ['events:PutEvents'], resources: ['*'] },
    {
      // SQS permission for self-dispatch via continuation queue
      actions: ['sqs:SendMessage'],
      resources: [agentContinuationQueue.arn],
    },
  ],
  copyFiles: [
    {
      from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
      to: 'tiktoken_bg.wasm',
    },
  ],
};

export const agentExecutor = new sst.aws.Function('AgentExecutor', {
  ...SHARED_AGENT_EXECUTOR_CONFIG,
  versioning: true,
  concurrency: ['production', 'dev'].includes($app.stage)
    ? {
        provisioned: $app.stage === 'production' ? 3 : 1,
        reserved: 10,
      }
    : undefined,
});

// Subscribe to the continuation queue for Lambda self-dispatch resume
export const agentContinuationQueueSubscription = agentContinuationQueue.subscribe(
  {
    ...SHARED_AGENT_EXECUTOR_CONFIG,
    concurrency: ['production', 'dev'].includes($app.stage) ? { reserved: 5 } : undefined,
  },
  {
    // The SQS branch of the handler already loops event.Records and reports per-record
    // failures (see queueHandlers/agentExecutor.ts) instead of throwing for the whole
    // batch, so a transient failure is retried/DLQ'd without reprocessing successes.
    batch: { partialResponses: true },
  }
);

// WebSocket route: agent_execute
// Dispatches commands (start/abort/permission_response/reconnect) to the Agent Executor.
// Defined here instead of websocket.ts to avoid circular dependency.
websocketApi.route('agent_execute', {
  handler: 'apps/client/server/websocket/agentExecute.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  // 256 MB ran out of memory on cold start (Node 24 + Mongoose + AWS SDK) — matches
  // the lifecycle-handler issue fixed in PR #8449. Symptom: every invocation hit
  // INIT or 30s function timeout with no application logs.
  memory: '1024 MB',
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi, agentExecutor],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
    {
      // P2 #8: Scoped to agent executor only
      actions: ['lambda:InvokeFunction'],
      resources: [agentExecutor.arn],
    },
  ],
});
