import { defineEndpoint } from '../defineEndpoint';
import {
  BriefDecisionEditSchema,
  BriefDecisionParamsSchema,
  BriefDecisionResolveSchema,
  BriefDecisionSchema,
  BriefFollowUpRequestSchema,
  BriefIdParamSchema,
  BriefListResponseSchema,
  BriefReplyRequestSchema,
  BriefReplyResponseSchema,
  BriefScheduleResponseSchema,
  BriefScheduleSchema,
  BriefSchema,
  BusyBlocksResponseSchema,
  PendingDecisionCountSchema,
  PutBusyBlocksSchema,
} from '../../schemas/brief';
import { ApiErrorSchema } from '../../schemas/chat';

const JWT_ONLY_NOTE =
  'Authenticate with a JWT access token of the signed-in user. A brief is readable only by the user it was ' +
  'composed for; anyone else gets `404`, exactly like a missing brief. Nothing in a push notification ' +
  'authorizes this call. ';

/**
 * Assistant briefs for native clients. Served by apps/client/pages/api/v1/briefs/index.ts (compose, list),
 * apps/client/pages/api/v1/briefs/follow-ups.ts (follow-up intake), apps/client/pages/api/v1/briefs/[id].ts (read), .../[id]/decisions/[decisionId]/reply.ts (reply),
 * .../[id]/decisions/[decisionId]/index.ts + resolve.ts (follow-up edit, approve, dismiss),
 * apps/client/pages/api/v1/briefs/schedule.ts (schedule) and
 * apps/client/pages/api/v1/briefs/busy-blocks.ts (busy blocks). Composition runs in apps/workers/src/events/briefCompose.ts.
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

export const composeFollowUpBriefContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/briefs/follow-ups',
  operationId: 'composeFollowUpBrief',
  summary: 'Compose follow-ups from a dictated memo',
  description:
    'Turns a dictated memo (the transcript of a voice note after a meeting or call) into a brief whose ' +
    'decisions propose follow-ups: action items, a follow-up email draft and reminders, each carrying ' +
    '`followUp` in `pending` state. Nothing is sent or scheduled until you approve a decision. Composition is ' +
    'asynchronous like `POST /api/v1/briefs`: the response is the brief in `composing` status, then a ' +
    '`brief_ready` push (or polling `GET /api/v1/briefs/{id}`) signals `ready` or `failed`. Every call starts ' +
    'a new brief, and a follow-up brief does not change the window the next activity brief covers. ' +
    JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  request: BriefFollowUpRequestSchema,
  responses: {
    202: { description: 'The follow-ups are being composed.', schema: BriefSchema },
    400: {
      description: 'The transcript is empty, blank or too long, or the time zone is unknown.',
      schema: ApiErrorSchema,
    },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: '<access_token>',
    streaming: false,
    body: {
      transcript: 'Email Sam the notes from today and remind me to call the vendor tomorrow at 9.',
      timeZone: 'America/New_York',
    },
  },
});

export const listBriefsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/briefs',
  operationId: 'listBriefs',
  summary: 'List briefs',
  description:
    'Lists your most recent briefs (up to 20), newest first. A brief composed from a dictated memo is not listed; read it by id. ' +
    JWT_ONLY_NOTE,
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

const BRIEF_SCHEDULE_EXAMPLE = {
  enabled: true,
  timeOfDay: '08:00',
  days: [1, 2, 3, 4, 5],
  timeZone: 'America/New_York',
};

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
  requestExample: BRIEF_SCHEDULE_EXAMPLE,
  responses: {
    200: { description: 'The saved schedule.', schema: BriefScheduleResponseSchema },
    400: { description: 'Malformed JSON request body.', schema: ApiErrorSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', body: BRIEF_SCHEDULE_EXAMPLE, streaming: false },
});

const BUSY_BLOCKS_NOTE =
  "Authenticate with a JWT access token of the signed-in user. The busy blocks are the caller's own; only " +
  'start and end times are accepted, never event titles or attendees. A brief is composed after a block ' +
  'ends only when something arrived during it.';

const BUSY_BLOCKS_EXAMPLE = {
  enabled: true,
  blocks: [{ start: '2026-11-20T15:00:00.000Z', end: '2026-11-20T16:00:00.000Z' }],
};

export const getBusyBlocksContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/briefs/busy-blocks',
  operationId: 'getBusyBlocks',
  summary: 'Get your busy blocks',
  description: 'Reads the synced busy blocks and when the next block brief is due. ' + BUSY_BLOCKS_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  responses: {
    200: { description: 'Your busy blocks.', schema: BusyBlocksResponseSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false },
});

export const putBusyBlocksContract = defineEndpoint({
  method: 'put',
  path: '/api/v1/briefs/busy-blocks',
  operationId: 'putBusyBlocks',
  summary: 'Sync your busy blocks',
  description:
    "Replaces the stored busy blocks with the device calendar's next busy intervals and returns them merged, " +
    'with the next due time. Blocks more than 72 hours out and blocks already briefed are dropped. ' +
    BUSY_BLOCKS_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  request: PutBusyBlocksSchema,
  requestExample: BUSY_BLOCKS_EXAMPLE,
  responses: {
    200: { description: 'The stored busy blocks.', schema: BusyBlocksResponseSchema },
    400: { description: 'Malformed JSON request body.', schema: ApiErrorSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', body: BUSY_BLOCKS_EXAMPLE, streaming: false },
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

const FOLLOW_UP_DECISION_ERRORS = {
  401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
  404: {
    description: 'No such brief or decision, it is not yours, or the decision is not a follow-up.',
    schema: ApiErrorSchema,
  },
  409: {
    description: 'The follow-up was already approved or dismissed (`errorCode: "decision_closed"`).',
    schema: ApiErrorSchema,
  },
  429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
} as const;

export const editBriefDecisionContract = defineEndpoint({
  method: 'patch',
  path: '/api/v1/briefs/{id}/decisions/{decisionId}',
  operationId: 'editBriefDecision',
  summary: 'Edit a proposed follow-up',
  description:
    'Changes a follow-up decision (one carrying `followUp`) while it is still `pending`: `text` on any kind, ' +
    '`draftReply` fields only on a `followUpEmail`, `remindAt` only on a `reminder`. The response is the ' +
    'updated decision. Once the follow-up is approved or dismissed it cannot change; that is `409` with ' +
    '`errorCode: "decision_closed"`. ' +
    JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  pathParams: BriefDecisionParamsSchema,
  request: BriefDecisionEditSchema,
  responses: {
    200: { description: 'The updated decision.', schema: BriefDecisionSchema },
    400: {
      description: 'No field to change, or a field that does not apply to this kind of follow-up.',
      schema: ApiErrorSchema,
    },
    ...FOLLOW_UP_DECISION_ERRORS,
  },
  codeSample: {
    authToken: '<access_token>',
    streaming: false,
    body: { draftReply: { to: 'sam@example.com' } },
  },
});

export const resolveBriefDecisionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/briefs/{id}/decisions/{decisionId}/resolve',
  operationId: 'resolveBriefDecision',
  summary: 'Approve or dismiss a proposed follow-up',
  description:
    'Approves or dismisses a `pending` follow-up decision, once; the response is the updated decision. ' +
    'Approving records your approval and nothing more: the server never sends a `followUpEmail` (hand the ' +
    'approved `draftReply` to the device mail app) and needs `draftReply.to` to be an email address first. ' +
    'An approved `reminder` needs a `remindAt` and is listed in the first brief composed at or after it; with ' +
    'a brief schedule on, the next scheduled brief is moved earlier to that time. A second approve or dismiss ' +
    'is `409` with `errorCode: "decision_closed"`. ' +
    JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  pathParams: BriefDecisionParamsSchema,
  request: BriefDecisionResolveSchema,
  responses: {
    200: { description: 'The updated decision.', schema: BriefDecisionSchema },
    400: {
      description: 'Approving an email whose recipient is not an email address, or a reminder with no time.',
      schema: ApiErrorSchema,
    },
    ...FOLLOW_UP_DECISION_ERRORS,
  },
  codeSample: { authToken: '<access_token>', streaming: false, body: { outcome: 'approve' } },
});

/** Served by apps/client/pages/api/v1/pending-decisions.ts; counted by apps/client/server/briefs/countPendingDecisions.ts. */
export const getPendingDecisionCountContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/pending-decisions',
  operationId: 'getPendingDecisionCount',
  summary: 'Count decisions waiting on you',
  description:
    'The number of decisions waiting on you, for a badge or a lock-screen widget: the agent approvals still ' +
    'open in your notebooks plus the other decisions in your latest ready brief. Read-only and cheap; it ' +
    'composes nothing. Authenticate with a JWT access token of the signed-in user; only your own notebooks ' +
    'and briefs are counted.',
  tags: ['AI'],
  auth: 'jwtOnly',
  responses: {
    200: { description: 'The count.', schema: PendingDecisionCountSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false },
});
