import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { DelegationCreateRequestSchema, DelegationIdParamSchema, DelegationSchema } from '../../schemas/delegation';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * Delegated items: forward something to the assistant with one line of intent. Served by
 * apps/client/pages/api/v1/delegations/index.ts (create) and [id].ts (read); the work runs in
 * apps/workers/src/events/delegationProcess.ts and its outcome is folded into the next brief
 * (apps/workers/src/events/briefCompose.ts).
 */
export const createDelegationContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/delegations',
  operationId: 'createDelegation',
  summary: 'Delegate an item to the assistant',
  description:
    'Hands a link, some text and/or files you uploaded to the assistant with one line of intent ("handle ' +
    'this", "summarize for the team"). Send at least one of `url`, `text` or `file_ids`; with none the call ' +
    'is a `422`. The work is asynchronous: the response is the delegation in `pending` status, and polling ' +
    '`GET /api/v1/delegations/{id}` shows it settle as `handled`, `needs_decision` or `failed`. Either way it ' +
    'appears in your next brief: still-pending items as in progress, settled ones once. Authenticate with an ' +
    'API key (`b4m_live_`) or a JWT.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  request: DelegationCreateRequestSchema,
  requestExample: { intent: 'Summarize this for the team', url: 'https://example.com/report' },
  responses: {
    202: { description: 'Accepted; the assistant is working on it.', schema: DelegationSchema },
    404: {
      description: "A `file_ids` entry names no file of yours. Another user's file is reported the same way.",
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
    502: {
      description: 'The work could not be dispatched. The delegation is marked `failed`, so a retry is safe.',
      schema: ApiErrorSchema,
    },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { intent: 'Summarize this for the team', url: 'https://example.com/report' },
  },
});

export const getDelegationContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/delegations/{id}',
  operationId: 'getDelegation',
  summary: 'Get a delegation',
  description:
    'Reads one delegation and its outcome. Only the user who created it can read it; anyone else gets ' +
    '`404`, exactly like a missing one.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  pathParams: DelegationIdParamSchema,
  responses: {
    200: { description: 'The delegation.', schema: DelegationSchema },
    404: { description: 'No such delegation, or it is not yours.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
