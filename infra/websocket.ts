import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';

const websocketApi = new sst.aws.ApiGatewayWebSocket('websocket', {});

// Lifecycle handlers run a full Mongoose + AWS SDK stack on every cold start.
// 256 MB triggered Runtime.OutOfMemory + 10s init timeouts on low-traffic
// preview envs, which surfaced as 504 during the WebSocket handshake.
const LIFECYCLE_MEMORY = '1024 MB';

websocketApi.route('$default', {
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
websocketApi.route('$connect', {
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
websocketApi.route('$disconnect', {
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
websocketApi.route('heartbeat', {
  handler: 'apps/client/server/websocket/heartbeat.func',
  runtime: 'nodejs24.x',
  memory: '512 MB',
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

websocketApi.route('voice_session_send_transcript', {
  handler: 'apps/client/server/websocket/voiceSessionSendTranscript.func',
  runtime: 'nodejs24.x',
  timeout: '10 minutes',
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});

websocketApi.route('voice_session_ended', {
  handler: 'apps/client/server/websocket/voiceSessionEnded.func',
  runtime: 'nodejs24.x',
  timeout: '5 minutes',
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});

// CLI Completions — streaming, long-running (bypasses CloudFront 20s timeout)
// @see https://github.com/MillionOnMars/lumina5/issues/6634
websocketApi.route('cli_completion_request', {
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
  memory: '512 MB',
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
  memory: '256 MB',
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
  memory: '256 MB',
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
  memory: '256 MB',
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
  memory: '256 MB',
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
  memory: '256 MB',
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
  memory: '256 MB',
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

export { websocketApi };
