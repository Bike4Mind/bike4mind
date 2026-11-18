import { defineEndpoint } from '../defineEndpoint';
import { BriefIdParamSchema, BriefListResponseSchema, BriefSchema } from '../../schemas/brief';
import { ApiErrorSchema } from '../../schemas/chat';

const JWT_ONLY_NOTE =
  'Authenticate with a JWT access token of the signed-in user. A brief is readable only by the user it was ' +
  'composed for; anyone else gets `404`, exactly like a missing brief. Nothing in a push notification ' +
  'authorizes this call. ';

/**
 * Assistant briefs for native clients. Served by apps/client/pages/api/v1/briefs/index.ts (compose, list)
 * and apps/client/pages/api/v1/briefs/[id].ts (read). Composition runs in apps/workers/src/events/briefCompose.ts.
 */
export const composeBriefContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/briefs',
  operationId: 'composeBrief',
  summary: 'Compose a brief',
  description:
    'Asks the assistant to compose a brief of what happened since the last one, what it handled and what ' +
    'needs a decision. Composition is asynchronous: the response is the brief in `composing` status, and ' +
    'a `brief_ready` push (or polling `GET /api/v1/briefs/{id}`) signals `ready` or `failed`. Idempotent ' +
    'while a brief is composing: the same brief is returned instead of starting another. ' +
    JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  responses: {
    202: { description: 'The brief is being composed.', schema: BriefSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false },
});

export const listBriefsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/briefs',
  operationId: 'listBriefs',
  summary: 'List briefs',
  description: 'Lists your most recent briefs (up to 20), newest first. ' + JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  responses: {
    200: { description: 'Your recent briefs.', schema: BriefListResponseSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false },
});

export const getBriefContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/briefs/{id}',
  operationId: 'getBrief',
  summary: 'Get a brief',
  description:
    'Reads one brief. Decision items that reference an agent approval carry its `questId` and ' +
    '`pendingActionTs`; answer it through the pending-actions endpoints. ' +
    JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  pathParams: BriefIdParamSchema,
  responses: {
    200: { description: 'The brief.', schema: BriefSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    404: { description: 'No such brief, or it is not yours.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false },
});
