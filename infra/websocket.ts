import { DEFAULT_LAMBDA_ENVIRONMENT, STAGE_LOG_RETENTION } from './constants';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';

// Access logs carry client IPs; use the stage default instead of SST's flat 1 month.
const websocketApi = new sst.aws.ApiGatewayWebSocket('websocket', {
  accessLog: { retention: STAGE_LOG_RETENTION },
});

// Memory is set per route so a change shows in review. The cold-start Mongoose + AWS SDK
// init sets the floor: lifecycle handlers at 256 MB hit OOM and init timeouts on previews.
const LIFECYCLE_MEMORY = '1024 MB';
const DB_HANDLER_MEMORY = '512 MB';
const RELAY_MEMORY = '256 MB';

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
// No VPC, unlike the other routes: the handler runs with skipDatabase and only posts `pong` back
// through the API Gateway management endpoint. If it ever opens the database, restore `vpc`; see
// docs/architecture/lambda-vpc-audit.md and infra/__tests__/lambdaVpcAudit.test.ts.
const heartbeatRoute = websocketApi.route('heartbeat', {
  handler: 'apps/client/server/websocket/heartbeat.func',
  runtime: 'nodejs24.x',
  memory: DB_HANDLER_MEMORY,
  timeout: '30 seconds',
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
  memory: LIFECYCLE_MEMORY,
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
  memory: LIFECYCLE_MEMORY,
  vpc: lambdaVpc,
  link: [...allSecrets, websocketApi],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});

// CLI Tool Execution — request-response
const cliToolRoute = websocketApi.route('cli_tool_request', {
  handler: 'apps/client/server/websocket/cliToolExecution.func',
  runtime: 'nodejs24.x',
  timeout: '10 minutes',
  memory: DB_HANDLER_MEMORY,
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
const keepCommandRequestRoute = websocketApi.route('keep_command_request', {
  handler: 'apps/client/server/websocket/keepCommandRequest.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: RELAY_MEMORY,
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

const keepCommandResponseRoute = websocketApi.route('keep_command_response', {
  handler: 'apps/client/server/websocket/keepCommandResponse.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: RELAY_MEMORY,
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
const jupyterCellOutputRoute = websocketApi.route('jupyter_cell_output', {
  handler: 'apps/client/server/websocket/jupyterNotebookProgress.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: RELAY_MEMORY,
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
const ccAgentRegisterRoute = websocketApi.route('cc_agent_register', {
  handler: 'apps/client/server/websocket/ccAgentRegister.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: RELAY_MEMORY,
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
const ccAgentEventRoute = websocketApi.route('cc_agent_event', {
  handler: 'apps/client/server/websocket/ccAgentEvent.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: RELAY_MEMORY,
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
const ccAgentDisconnectRoute = websocketApi.route('cc_agent_disconnect', {
  handler: 'apps/client/server/websocket/ccAgentDisconnect.func',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: RELAY_MEMORY,
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
  defaultRoute,
  connectRoute,
  disconnectRoute,
  heartbeatRoute,
  voiceSendTranscriptRoute,
  voiceEndedRoute,
  cliToolRoute,
  keepCommandRequestRoute,
  keepCommandResponseRoute,
  jupyterCellOutputRoute,
  ccAgentRegisterRoute,
  ccAgentEventRoute,
  ccAgentDisconnectRoute,
};
