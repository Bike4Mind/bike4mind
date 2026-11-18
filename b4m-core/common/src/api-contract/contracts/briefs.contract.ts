import { defineEndpoint } from '../defineEndpoint';
import {
  BriefDecisionParamsSchema,
  BriefIdParamSchema,
  BriefListResponseSchema,
  BriefReplyRequestSchema,
  BriefReplyResponseSchema,
  BriefScheduleResponseSchema,
  BriefScheduleSchema,
  BriefSchema,
} from '../../schemas/brief';
import { ApiErrorSchema } from '../../schemas/chat';

const JWT_ONLY_NOTE =
  'Authenticate with a JWT access token of the signed-in user. A brief is readable only by the user it was ' +
  'composed for; anyone else gets `404`, exactly like a missing brief. Nothing in a push notification ' +
  'authorizes this call. ';

/**
 * Assistant briefs for native clients. Served by apps/client/pages/api/v1/briefs/index.ts (compose, list),
 * apps/client/pages/api/v1/briefs/[id].ts (read), .../[id]/decisions/[decisionId]/reply.ts (reply) and
 * apps/client/pages/api/v1/briefs/schedule.ts (schedule). Composition runs in apps/workers/src/events/briefCompose.ts.
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
    '`pendingActionTs`; answer it through the pending-actions endpoints. Items triaged from an ingested email ' +
    'carry a `source`, and an email decision may carry a `draftReply` for you to review; nothing sends it. ' +
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

const SCHEDULE_NOTE =
  "Authenticate with a JWT access token of the signed-in user. The schedule is the caller's own; scheduled " +
  'briefs are composed only when there was activity since the last one.';

export const getBriefScheduleContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/briefs/schedule',
  operationId: 'getBriefSchedule',
  summary: 'Get your brief schedule',
  description: 'Reads when scheduled briefs are composed for you and when the next one is due. ' + SCHEDULE_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  responses: {
    200: { description: 'Your brief schedule.', schema: BriefScheduleResponseSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false },
});

export const putBriefScheduleContract = defineEndpoint({
  method: 'put',
  path: '/api/v1/briefs/schedule',
  operationId: 'putBriefSchedule',
  summary: 'Set your brief schedule',
  description:
    'Replaces your brief schedule and returns it with the next due time. `timeOfDay` and `days` are read ' +
    'in `timeZone`, so a time skipped by a daylight-saving change runs at the shifted time and a repeated ' +
    'one runs once. ' +
    SCHEDULE_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  request: BriefScheduleSchema,
  requestExample: { enabled: true, timeOfDay: '08:00', days: [1, 2, 3, 4, 5], timeZone: 'America/New_York' },
  responses: {
    200: { description: 'The saved schedule.', schema: BriefScheduleResponseSchema },
    400: { description: 'Invalid schedule.', schema: ApiErrorSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false },
});

export const replyToBriefDecisionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/briefs/{id}/decisions/{decisionId}/reply',
  operationId: 'replyToBriefDecision',
  summary: 'Reply to a brief question',
  description:
    'Answers a decision item that carries a `question`: the reply is sent to the agent as your next message ' +
    'in that notebook, starting an agent run. A question can be answered from the brief once; a second ' +
    'reply, or one after the conversation moved on (`state` other than `open`), is `409` with ' +
    '`errorCode: "question_closed"`. A decision that is an approval is `404` here; answer it through the ' +
    'pending-actions endpoints. ' +
    JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  pathParams: BriefDecisionParamsSchema,
  request: BriefReplyRequestSchema,
  responses: {
    202: { description: 'The reply was sent and the agent run started.', schema: BriefReplyResponseSchema },
    400: {
      description: '`choiceIndex` is not one of the question options, or the billing key needs re-checking.',
      schema: ApiErrorSchema,
    },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    403: { description: 'AI access is held on the account.', schema: ApiErrorSchema },
    404: { description: 'No such brief or question, or it is not yours.', schema: ApiErrorSchema },
    409: {
      description: 'The question is closed, or too many agent runs are already in flight.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
    502: {
      description:
        'The agent run could not be started. When the dispatch could not be confirmed either way the question ' +
        'stays answered so the reply can never run twice; open the conversation to see whether it went through. ' +
        'Otherwise nothing was sent and the question stays open for another reply.',
      schema: ApiErrorSchema,
    },
  },
  codeSample: {
    authToken: '<access_token>',
    streaming: false,
    body: { text: 'Go with the second option.', choiceIndex: 1 },
  },
});
