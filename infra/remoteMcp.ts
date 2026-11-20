import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';

// Runs custom (user-supplied URL) MCP calls. Deliberately no `vpc` and no `link`: it reaches
// arbitrary public hosts, so it must hold no VPC route to private resources and no secrets. The
// caller decrypts credentials and sends them in the invoke payload.
export const remoteMcpHandler = new sst.aws.Function('remoteMcpHandler', {
  handler: 'apps/workers/src/mcp/remoteMcpCall.handler',
  runtime: 'nodejs24.x',
  // Must outlive its own client's connect + call limits; the web caller's 60 s timeout is the
  // effective ceiling for a request.
  timeout: '90 seconds',
  memory: '512 MB',
  environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
});
