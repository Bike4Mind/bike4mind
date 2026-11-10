import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';

const websocketApi = new sst.aws.ApiGatewayWebSocket('websocket', {});

// ── Memory sizing ──────────────────────────────────────────────────────
// Every route sets memory explicitly so changes are visible in code review.
// SST default is 1024 MB; relying on it silently masks whether a route
// needs that much.
//
// Tiers (cold-start stack drives the floor):
//   LIFECYCLE  1024 MB — $connect/$disconnect/$default: full Mongoose + AWS SDK init.
//                        256 MB hit OOM + 10s init timeouts on preview envs.
//   HEAVY      2048 MB — cli_completion_request: streams Bedrock responses.
//   MEDIUM      512 MB — heartbeat, cli_tool_request, voice routes: lighter
//                        handlers but still init the DB + SDK stack.
//   LIGHT       256 MB — keep_command_*, jupyter_cell_output, cc_agent_*:
//                        thin relay / fanout handlers with minimal heap.
//
// When CloudWatch max-memory-used data becomes available, update the values
// here and reference the measurement window in the commit message.
// ────────────────────────────────────────────────────────────────────────

const LIFECYCLE_MEMORY = '1024 MB';
const MEDIUM_MEMORY = '512 MB';
const LIGHT_MEMORY = '256 MB';

const defaultRoute = websocketApi.route('$default', {
  handler: 'apps/client/server/websocket/default.handler',
  runtime: 'nodejs24.x',
  memory: LIFECYCLE_MEMORY,
  timeout: '600 seconds',
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
});
const connectRoute = websocketApi.route('$connect', {
  handler: 'apps/client/server/websocket/connect.func',
  runtime: 'nodejs24.x',
  memory: LIFECYCLE_MEMORY,
  timeout: '600 seconds',
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});
const disconnectRoute = websocketApi.route('$disconnect', {
  handler: 'apps/client/server/websocket/disconnect.func',
  runtime: 'nodejs24.x',
  memory: LIFECYCLE_MEMORY,
  timeout: '600 seconds',
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});
const heartbeatRoute = websocketApi.route('heartbeat', {
  handler: 'apps/client/server/websocket/heartbeat.func',
  runtime: 'nodejs24.x',
  memory: MEDIUM_MEMORY,
  timeout: '30 seconds',
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});

const voiceSendTranscriptRoute = websocketApi.route('voice_session_send_transcript', {
  handler: 'apps/client/server/websocket/voiceSessionSendTranscript.func',
  runtime: 'nodejs24.x',
  timeout: '10 minutes',
  memory: MEDIUM_MEMORY,
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});

const voiceEndedRoute = websocketApi.route('voice_session_ended', {
  handler: 'apps/client/server/websocket/voiceSessionEnded.func',
  runtime: 'nodejs24.x',
  timeout: '5 minutes',
  memory: MEDIUM_MEMORY,
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});

// CLI Completions — streaming, long-running (bypasses CloudFront 20s timeout)
// Its log group carries the same spend and overdraft lines as ChatCompletion: llmSpendLogGroups.ts
// lists it for the spend metric filters and the young-account alarm relay's query.
const cliCompletionRoute = websocketApi.route('cli_completion_request', {
  handler: 'apps/client/server/websocket/cliCompletion.func',
  runtime: 'nodejs24.x',
  timeout: '10 minutes',
  memory: '2048 MB',
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
    {
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    },
  ],
});

// CLI Tool Execution — request-response
websocketApi.route('cli_tool_request', {
  handler: 'apps/client/server/websocket/cliToolExecution.func',
  runtime: 'nodejs24.x',
  timeout: '10 minutes',
  memory: MEDIUM_MEMORY,
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
});

// Keep Command Relay — Web HUD ↔ CLI bidirectional command execution
websocketApi.route('keep_command_request', {
  handler: 'apps/client/server/websocket/keepCommandRequest.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: LIGHT_MEMORY,
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
});

websocketApi.route('keep_command_response', {
  handler: 'apps/client/server/websocket/keepCommandResponse.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: LIGHT_MEMORY,
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
});

// Jupyter Notebook Cell Output — streaming cell execution results from CLI
websocketApi.route('jupyter_cell_output', {
  handler: 'apps/client/server/websocket/jupyterNotebookProgress.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: LIGHT_MEMORY,
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
});

// Claude Code Bridge — a user's local `cc-bridge` daemon announces CC sessions
websocketApi.route('cc_agent_register', {
  handler: 'apps/client/server/websocket/ccAgentRegister.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: LIGHT_MEMORY,
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
});

// Claude Code Bridge — stream per-session events (status, message preview)
websocketApi.route('cc_agent_event', {
  handler: 'apps/client/server/websocket/ccAgentEvent.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: LIGHT_MEMORY,
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
});

// Claude Code Bridge — clean session teardown (safety net is $disconnect)
websocketApi.route('cc_agent_disconnect', {
  handler: 'apps/client/server/websocket/ccAgentDisconnect.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: LIGHT_MEMORY,
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  permissions: [
    {
      actions: ['execute-api:ManageConnections'],
      resources: ['*'],
    },
  ],
});

// NOTE: The agent_execute route is defined in infra/agentExecutor.ts to avoid
// a circular dependency (websocket.ts ↔ agentExecutor.ts both need each other).

export {
  websocketApi,
  cliCompletionRoute,
  defaultRoute,
  connectRoute,
  disconnectRoute,
  heartbeatRoute,
  voiceSendTranscriptRoute,
  voiceEndedRoute,
};
