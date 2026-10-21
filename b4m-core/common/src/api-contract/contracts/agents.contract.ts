import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  AgentIdParamSchema,
  AgentResourceSchema,
  CreateAgentRequestSchema,
  ListAgentsResponseSchema,
  UpdateAgentRequestSchema,
} from '../../schemas/agentPublic';
import { PaginationQuerySchema } from '../../schemas/pagination';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/**
 * The integrator-facing subset of the agent API. Each route is a `/api/v1` twin of an SPA route
 * under `/api/agents/*` and reuses its logic (server/agents/createAgent.ts, deleteAgent.ts); the SPA
 * routes are unchanged. The authoring assistants (generate-*, enhance-field), credit transfers and
 * create-from-context are deliberately not published.
 */

// agents:write is accepted for reads so a key that creates agents can read back what it wrote
// without also being minted agents:read.
const READ_SCOPES = [ApiKeyScope.READ_AGENTS, ApiKeyScope.WRITE_AGENTS];

const READ_FORBIDDEN = 'The API key holds neither `agents:read` nor `agents:write`.';
const WRITE_FORBIDDEN = 'The API key lacks `agents:write`.';

const BODY_422 =
  'Request body failed validation: an unknown field, an out-of-range value, an unknown ' +
  '`preferred_model`, or a malformed `trigger_words`/tool list.';

export const listAgentsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/agents',
  operationId: 'listAgents',
  summary: 'List agents',
  description:
    'Lists the agents the caller can use: agents they own and agents shared with them. ' +
    'Cursor-paginated (see the pagination convention): pass `next_cursor` back as `cursor` until it is `null`.',
  tags: ['Agents'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  queryParams: PaginationQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of agents, ordered by `id`.', schema: ListAgentsResponseSchema },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    422: {
      description:
        '`limit` is out of range, or `cursor` is malformed or was issued by a different endpoint. A ' +
        'cursor is opaque: pass back exactly the `next_cursor` you were given.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const getAgentContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/agents/{id}',
  operationId: 'getAgent',
  summary: 'Get an agent',
  description: 'Returns one agent the caller owns or that is shared with them.',
  tags: ['Agents'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  pathParams: AgentIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The agent.', schema: AgentResourceSchema },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: {
      description:
        'No agent with that id is visible to the caller. An agent that exists but is not yours to read, ' +
        'a deleted agent and a malformed id are all reported as 404, so agent ids cannot be probed ' +
        'through this endpoint.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

const CREATE_EXAMPLE = {
  name: 'Research assistant',
  description: 'Summarizes sources and cites them.',
  system_prompt: 'You are a careful research assistant. Always cite your sources.',
  temperature: 0.3,
  trigger_words: ['@research'],
};

export const createAgentContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/agents',
  operationId: 'createAgent',
  summary: 'Create an agent',
  description:
    'Creates an agent owned by the caller. The number of agents a user may own depends on their plan. ' +
    'Unknown body fields are rejected.',
  tags: ['Agents'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_AGENTS],
  request: CreateAgentRequestSchema,
  requestExample: CREATE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    201: { description: 'The created agent.', schema: AgentResourceSchema },
    400: {
      description:
        'The caller already owns as many agents as their plan allows (`errorCode: agent_limit_reached`), ' +
        'or the body is not valid JSON. Nothing is created.',
      schema: ApiErrorSchema,
    },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    422: { description: BODY_422, schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: CREATE_EXAMPLE },
});

const OWNER_ONLY_404 =
  'No agent with that id is yours. An agent shared with you, one that does not exist, a deleted agent ' +
  'and a malformed id are all reported as 404, so agent ids cannot be probed through this endpoint.';

const UPDATE_EXAMPLE = { temperature: 0.7, trigger_words: ['@research', '@sources'] };

export const updateAgentContract = defineEndpoint({
  method: 'patch',
  path: '/api/v1/agents/{id}',
  operationId: 'updateAgent',
  summary: 'Update an agent',
  description:
    'Updates an agent you own. Omitted fields are left unchanged. Only the owner can update an agent. ' +
    'Unknown body fields are rejected.',
  tags: ['Agents'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_AGENTS],
  pathParams: AgentIdParamSchema,
  request: UpdateAgentRequestSchema,
  requestExample: UPDATE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The updated agent.', schema: AgentResourceSchema },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: OWNER_ONLY_404, schema: ApiErrorSchema },
    422: { description: BODY_422, schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: UPDATE_EXAMPLE },
});

export const deleteAgentContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/agents/{id}',
  operationId: 'deleteAgent',
  summary: 'Delete an agent',
  description:
    'Deletes an agent you own. Any credits held by the agent are returned to your balance. Only the ' +
    'owner can delete an agent.',
  tags: ['Agents'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_AGENTS],
  pathParams: AgentIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    204: { description: 'The agent was deleted.', noBody: true },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: OWNER_ONLY_404, schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});
