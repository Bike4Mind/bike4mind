import { defineEndpoint } from '../defineEndpoint';
import {
  PendingActionDecisionRequestSchema,
  PendingActionDecisionResponseSchema,
  PendingActionErrorSchema,
  PendingActionParamSchema,
} from '../../schemas/pendingActions';
import { ApiErrorSchema } from '../../schemas/chat';

const JWT_ONLY_NOTE =
  'Authenticate with a JWT access token of the signed-in user: an API key cannot answer an approval. ' +
  'The caller must own the session the action belongs to; anyone else gets `404`, exactly like a ' +
  'missing action. Nothing in a push notification authorizes this call. ';

const LIFECYCLE =
  'An approval is answered once and only while it is current: it lapses 15 minutes after it was ' +
  'raised, and a newer approval on the same quest replaces it.';

const CONFLICT =
  'The action was replaced by a newer one (`errorCode: action_replaced`), lapsed (`action_expired`, ' +
  'and it is cleared), or was already answered (`action_already_resolved`). Also a custom connector ' +
  'tool that is no longer offered. Do not retry; review the quest for a newer approval.';

const REQUEST_EXAMPLE = { pendingActionTs: 1767225600000 };

/**
 * Answer an agent's pending approval from a native client. Served by
 * apps/client/pages/api/v1/pending-actions/[questId]/approve.ts and deny.ts, which share the web
 * route's resolver (apps/client/server/mcp/resolveMcpPendingAction.ts).
 */
export const approvePendingActionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/pending-actions/{questId}/approve',
  operationId: 'approvePendingAction',
  summary: 'Approve an agent action',
  description: 'Approves the tool call an agent is waiting on and runs it. ' + LIFECYCLE + ' ' + JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  pathParams: PendingActionParamSchema,
  request: PendingActionDecisionRequestSchema,
  requestExample: REQUEST_EXAMPLE,
  responses: {
    200: {
      description: 'The action ran. `success: false` means the tool reported a failure.',
      schema: PendingActionDecisionResponseSchema,
    },
    400: {
      description: 'The action cannot be confirmed (not a confirmable tool, or its repository is not enabled).',
      schema: ApiErrorSchema,
    },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    403: {
      description:
        'MCP servers or custom connectors are disabled, or a file the action attaches is not accessible to you.',
      schema: ApiErrorSchema,
    },
    404: { description: 'No such quest, or it is not yours.', schema: ApiErrorSchema },
    409: { description: CONFLICT, schema: PendingActionErrorSchema },
    422: { description: 'The body is not `{ pendingActionTs }`.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
    502: { description: 'The file the action attaches could not be downloaded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false, body: REQUEST_EXAMPLE },
});

export const denyPendingActionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/pending-actions/{questId}/deny',
  operationId: 'denyPendingAction',
  summary: 'Deny an agent action',
  description: 'Declines the tool call an agent is waiting on; nothing runs. ' + LIFECYCLE + ' ' + JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  pathParams: PendingActionParamSchema,
  request: PendingActionDecisionRequestSchema,
  requestExample: REQUEST_EXAMPLE,
  responses: {
    200: { description: 'The action was denied and cleared.', schema: PendingActionDecisionResponseSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    404: { description: 'No such quest, or it is not yours.', schema: ApiErrorSchema },
    409: { description: CONFLICT, schema: PendingActionErrorSchema },
    422: { description: 'The body is not `{ pendingActionTs }`.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false, body: REQUEST_EXAMPLE },
});
