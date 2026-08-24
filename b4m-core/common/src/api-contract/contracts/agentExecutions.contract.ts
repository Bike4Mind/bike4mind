import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  AgentExecutionStartRequestSchema,
  AgentExecutionAckSchema,
  AgentExecutionStatusResponseSchema,
  AgentExecutionIdParamSchema,
} from '../../schemas/agentExecution';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * Contracts for the agent-executor (ReAct) pipeline over REST.
 *
 * This is the pipeline behind the product UI's Agent Mode toggle, which until now was
 * reachable only over the `agent_execute` WebSocket route - so an API-key caller could
 * reproduce a chat turn (`POST /api/chat`) but not an agent run. `POST /api/chat` runs
 * a different pipeline and cannot substitute: it is a single completion, not a
 * tool-using ReAct loop.
 *
 * Long-running work follows CONVENTIONS.md section 4: start returns `202` plus a job
 * resource, and the caller polls `GET /api/v1/agent-executions/{id}`. There is no
 * `wait: true` escape here - a ReAct run can span multiple Lambda handoffs and has no
 * bounded duration to block on.
 */
export const startAgentExecutionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/agent-executions',
  operationId: 'startAgentExecution',
  summary: 'Start an agent execution',
  description:
    'Runs the tool-using agent (ReAct) loop against a session - the same pipeline the product ' +
    "UI's Agent Mode toggle dispatches to, and the REST equivalent of the `agent_execute` " +
    'WebSocket command. The run is asynchronous: this returns `202` with an execution id, and ' +
    'the caller polls `GET /api/v1/agent-executions/{id}` until `status` is terminal ' +
    '(`completed`, `failed`, or `aborted`). Nothing is streamed back over REST - for live ' +
    'iteration events, use the WebSocket route instead. Omit `agent_id` to get the profile the ' +
    "session's own surface resolves to, which is what reproduces the in-app toggle. The final " +
    'reply is also written to the session as a normal chat message, so it appears in history. ' +
    'Authenticate with an API key (`b4m_live_`) or a JWT.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  request: AgentExecutionStartRequestSchema,
  requestExample: { session_id: '<sessionId>', message: 'Audit this data set and summarize what stands out.' },
  // Served by baseApi (via nextRouteForContract), so apiKeyRateLimit sets the windowed
  // X-RateLimit-* headers on every API-key-authenticated response.
  emitsRateLimitHeaders: true,
  responses: {
    202: {
      description: 'Run accepted and dispatched. Poll `tracking_info.poll_url` for status and the answer.',
      schema: AgentExecutionAckSchema,
    },
    400: { description: 'No usable default chat model is configured and none was supplied.', schema: ApiErrorSchema },
    403: {
      description: 'The caller is not a member of the organization named by `organization_id`.',
      schema: ApiErrorSchema,
    },
    404: {
      description:
        'No session with the given `session_id` is owned by the caller, or `organization_id` names an ' +
        'organization that does not exist. A session that exists but belongs to someone else is reported ' +
        'as 404 too, so the endpoint cannot be used to probe which session ids exist.',
      schema: ApiErrorSchema,
    },
    409: {
      description:
        'The caller already has the maximum number of agent runs in flight - a per-user cap shared with ' +
        'runs started from the product UI. Wait for one to reach a terminal status before starting ' +
        'another; aborting a run is currently only possible over the WebSocket route.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
    502: {
      description: 'The executor could not be dispatched. The run did not start, so a retry is safe.',
      schema: ApiErrorSchema,
    },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { session_id: '<sessionId>', message: 'Audit this data set and summarize what stands out.' },
  },
});

export const getAgentExecutionContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/agent-executions/{id}',
  operationId: 'getAgentExecution',
  summary: 'Get an agent execution',
  description:
    'Returns the status, reasoning trace, and (once terminal) the final answer of a run started by ' +
    '`POST /api/v1/agent-executions`. `steps` grows while the run is in flight, so polling this ' +
    'endpoint is also how a REST caller follows the loop. Safe (GET) requests on this route are ' +
    'exempt from the per-day API-key quota so polling a single run costs one daily slot, not one per ' +
    'poll; the per-minute burst limit still applies.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  pathParams: AgentExecutionIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The execution, its trace, and its answer if it has finished.',
      schema: AgentExecutionStatusResponseSchema,
    },
    404: {
      description: 'No execution with that id is visible to the caller.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: {},
  },
});
