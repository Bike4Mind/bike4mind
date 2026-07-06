import { lambdaVpc } from './vpc';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { allSecrets } from './secrets';
import { websocketApi } from './websocket';

/**
 * CLI WebSocket Completion Handler
 *
 * Accepts HTTP POST with the full completion request payload (no size limit),
 * then streams the LLM response back via WebSocket (no CloudFront timeout).
 *
 * Uses a direct Lambda function URL (NOT behind CloudFront) to avoid the 20s
 * origin read timeout that breaks long-running SSE streams.
 */
export const cliWsCompletionHandler = new sst.aws.Function('CliWsCompletionHandler', {
  handler: 'apps/client/server/cli/wsCompletions.handler',
  runtime: 'nodejs24.x',
  timeout: '15 minutes',
  memory: '2048 MB',
  vpc: lambdaVpc,
  url: true, // Direct Lambda function URL — no CloudFront, no 20s timeout
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    },
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
  logging: {
    retention: '3 days',
  },
});
