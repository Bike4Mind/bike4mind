import { appFilesBucket, fabFileBucket, generatedImagesBucket } from './buckets';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { eventBus } from './eventBus';
import { slackEventBus } from './bus';
import { imageProcessor } from './imageProcessor';
import { mcpHandler } from './mcp';
import { allSecrets } from './secrets';
import { websocketApi } from './websocket';
import { lambdaVpc } from './vpc';
import { cdnUrlForLambdaEnv } from './router';

// Re-export imageProcessor for other files that import from functions.ts
export { imageProcessor };

/**
 * Slack Quest Processor Lambda Function
 *
 * Handles Slack-originated completion requests routed via SlackEventBus.
 * Owns all Slack-specific logic (tools, pending actions, async notification).
 * Web-originated completions are handled by the always-on QuestProcessorService
 * (infra/questProcessorService.ts), not a Lambda.
 */
export const slackQuestProcessor = new sst.aws.Function('SlackQuestProcessor', {
  handler: 'apps/client/server/queueHandlers/slackQuestProcessor.handler',
  runtime: 'nodejs24.x',
  timeout: '15 minutes',
  memory: '2048 MB',
  vpc: lambdaVpc,
  versioning: true,
  concurrency: ['production', 'dev'].includes($app.stage)
    ? {
        provisioned: $app.stage === 'production' ? 2 : 1,
        reserved: 10,
      }
    : undefined,
  link: [
    ...allSecrets,
    fabFileBucket,
    generatedImagesBucket,
    appFilesBucket,
    websocketApi,
    mcpHandler,
    eventBus,
    slackEventBus,
    imageProcessor,
  ],
  logging: {
    retention: '3 days',
  },
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
    // Personal sst dev stages serve files via the local proxy (apps/client/pages/api/app-files/serve); deployed stages use the real distribution.
    NEXT_PUBLIC_CDN_URL: cdnUrlForLambdaEnv(),
  },
  permissions: [
    { actions: ['bedrock:*'], resources: ['*'] },
    // Content moderation for images produced by the image_generation/edit_image tools
    // (closes an agent-tool moderation bypass; the queue-handler imageGeneration/
    // imageEdit queues already have this).
    { actions: ['rekognition:DetectModerationLabels'], resources: ['*'] },
    { actions: ['xray:*'], resources: ['*'] },
    {
      actions: [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
        'transcribe:ListTranscriptionJobs',
        'transcribe:DeleteTranscriptionJob',
      ],
      resources: ['*'],
    },
    {
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe', 'aws-marketplace:Unsubscribe'],
      resources: ['*'],
    },
    { actions: ['events:PutEvents'], resources: ['*'] },
  ],
  copyFiles: [
    {
      from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
      to: 'tiktoken_bg.wasm',
    },
  ],
});
