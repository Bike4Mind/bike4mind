import { lambdaVpc } from './vpc';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { router, routePrefix } from './router';
import { allSecrets } from './secrets';

export const cliLlmHandler = new sst.aws.Function('CliLlmHandler', {
  handler: 'apps/client/server/cli/completions.handler',
  runtime: 'nodejs24.x',
  timeout: '15 minutes',
  memory: '2048 MB',
  vpc: lambdaVpc,
  streaming: true, // Enable Lambda response streaming for SSE
  url: {
    router: {
      instance: router, // Use existing CloudFront router
      path: `${routePrefix}/api/ai/v1/completions`, // Versioned API path (with stage prefix in shared dev)
    },
  },
  link: [...allSecrets],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['bedrock:*'],
      resources: ['*'],
    },
  ],
  logging: {
    retention: '3 days',
  },
});
