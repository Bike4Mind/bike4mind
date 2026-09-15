import { lambdaVpc } from './vpc';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { router, routePrefix } from './router';
import { allSecrets } from './secrets';

export const cliToolHandler = new sst.aws.Function('CliToolHandler', {
  handler: 'apps/client/server/cli/tools.handler',
  runtime: 'nodejs24.x',
  timeout: '10 minutes', // Tools need longer timeout than typical API calls
  memory: '512 MB', // I/O-bound workload (API calls), less memory than LLM handler
  vpc: lambdaVpc,
  url: {
    router: {
      instance: router,
      path: `${routePrefix}/api/ai/v1/tools`, // Tool execution endpoint (with stage prefix in shared dev)
    },
  },
  link: [...allSecrets],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  logging: {
    retention: '3 days',
  },
});
