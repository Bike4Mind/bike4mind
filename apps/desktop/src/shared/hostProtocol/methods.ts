import { z, type ZodType } from 'zod';
import { eventCursorSchema } from './cursor';
import { hostProtocolVersionSchema, hostCapabilitiesSchema } from './version';
import {
  chatApprovalAnswerPayloadSchema,
  chatModelCatalogPayloadSchema,
  chatQueuedMessagePayloadSchema,
  chatQueueEventPayloadSchema,
  chatSessionPayloadSchema,
  chatSessionStatusEventPayloadSchema,
  chatSessionSummaryPayloadSchema,
  chatStreamEventPayloadSchema,
  createCodeSessionRequestPayloadSchema,
  createCodeSessionResultPayloadSchema,
  newSessionDefaultsPayloadSchema,
  pendingTaskDecisionPayloadSchema,
  sendMessageRequestPayloadSchema,
  sendMessageResultPayloadSchema,
  taskDecisionAnswerPayloadSchema,
} from './payloads';

// JSON-RPC lets a caller leave `params` out entirely, so a method with nothing to say accepts that.
const noParams = z.object({}).optional();
const emptyResult = z.object({});

const hostAccountSchema = z.object({ userId: z.string(), environmentUrl: z.string() });

const hostInfoSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  hostVersion: z.string(),
  protocol: hostProtocolVersionSchema,
  capabilities: hostCapabilitiesSchema,
  platform: z.string(),
  homeDirectory: z.string(),
  account: hostAccountSchema.nullable(),
});

const sessionIdParams = z.object({ sessionId: z.string() });

/** Mirrors answerTaskDecision's arguments; an approval's `requestId` is the id respondToApproval takes. */
const requestRespondParams = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), requestId: z.string(), answer: chatApprovalAnswerPayloadSchema }),
  z.object({
    kind: z.literal('taskDecision'),
    sessionId: z.string(),
    decisionId: z.string(),
    answer: taskDecisionAnswerPayloadSchema,
  }),
]);

export const hostMethods = {
  'host/initialize': {
    params: z.object({
      clientId: z.string(),
      clientName: z.string(),
      clientVersion: z.string(),
      protocol: hostProtocolVersionSchema,
    }),
    result: hostInfoSchema,
  },
  'host/info': { params: noParams, result: hostInfoSchema },
  'host/auth/start': {
    params: noParams,
    result: z.object({ verificationUrl: z.string(), userCode: z.string(), expiresAt: z.number() }),
  },
  'host/auth/status': { params: noParams, result: z.object({ account: hostAccountSchema.nullable() }) },
  'session/list': { params: noParams, result: z.object({ sessions: z.array(chatSessionSummaryPayloadSchema) }) },
  'session/get': {
    params: z.object({ sessionId: z.string(), viewed: z.boolean().optional() }),
    result: z.object({ session: chatSessionPayloadSchema.nullable(), cursor: eventCursorSchema }),
  },
  // Absent params start a plain chat session, like chatCreateSession; the reply is the Code
  // session's result shape, with a plain chat session reported as ok: true.
  'session/create': {
    params: createCodeSessionRequestPayloadSchema.optional(),
    result: createCodeSessionResultPayloadSchema,
  },
  'session/rename': {
    params: z.object({ sessionId: z.string(), title: z.string() }),
    result: z.object({ summary: chatSessionSummaryPayloadSchema.nullable() }),
  },
  'session/setArchived': {
    params: z.object({ sessionId: z.string(), archived: z.boolean() }),
    result: z.object({ summary: chatSessionSummaryPayloadSchema.nullable() }),
  },
  'session/delete': {
    params: z.object({ sessionId: z.string(), removeWorktree: z.boolean().optional() }),
    result: emptyResult,
  },
  // The host replays events after `after`, then streams live; when it cannot it fails with snapshotRequired.
  'session/subscribe': {
    params: z.object({ sessionId: z.string(), after: eventCursorSchema.optional() }),
    result: z.object({ cursor: eventCursorSchema }),
  },
  'session/unsubscribe': { params: sessionIdParams, result: emptyResult },
  'session/statuses': {
    params: noParams,
    result: z.object({ statuses: z.array(chatSessionStatusEventPayloadSchema) }),
  },
  'turn/send': { params: sendMessageRequestPayloadSchema, result: sendMessageResultPayloadSchema },
  'turn/stop': { params: sessionIdParams, result: emptyResult },
  'request/respond': { params: requestRespondParams, result: emptyResult },
  'queue/list': { params: sessionIdParams, result: z.object({ queued: z.array(chatQueuedMessagePayloadSchema) }) },
  'queue/cancel': { params: z.object({ sessionId: z.string(), queuedId: z.string() }), result: emptyResult },
  'queue/sendNow': { params: z.object({ sessionId: z.string(), queuedId: z.string() }), result: emptyResult },
  'background/stop': { params: z.object({ sessionId: z.string(), processId: z.string() }), result: emptyResult },
  // Directories only; an absent path means the host's home directory.
  'fs/browse': {
    params: z.object({ path: z.string().optional() }),
    result: z.object({
      path: z.string(),
      parent: z.string().nullable(),
      entries: z.array(z.object({ name: z.string(), path: z.string(), isGitRepository: z.boolean() })),
    }),
  },
  'project/recent': {
    params: noParams,
    result: z.object({ folders: z.array(z.object({ path: z.string(), name: z.string() })) }),
  },
  'model/list': {
    params: z.object({ force: z.union([z.boolean(), z.literal('local')]).optional() }),
    result: z.object({ models: chatModelCatalogPayloadSchema }),
  },
  'draft/defaults': { params: noParams, result: z.object({ defaults: newSessionDefaultsPayloadSchema }) },
} as const satisfies Record<string, { params: ZodType; result: ZodType }>;

export const hostNotifications = {
  'session/event': {
    params: z.object({
      sessionId: z.string(),
      seq: z.number().int().nonnegative(),
      event: chatStreamEventPayloadSchema,
    }),
  },
  'session/summaryChanged': { params: z.object({ summary: chatSessionSummaryPayloadSchema }) },
  'session/statusChanged': { params: z.object({ event: chatSessionStatusEventPayloadSchema }) },
  'session/queueChanged': { params: z.object({ event: chatQueueEventPayloadSchema }) },
  'session/taskDecisionsChanged': { params: z.object({ decisions: z.array(pendingTaskDecisionPayloadSchema) }) },
  'host/stateChanged': { params: z.object({ account: hostAccountSchema.nullable() }) },
} as const satisfies Record<string, { params: ZodType }>;

export type HostMethod = keyof typeof hostMethods;
export type HostParams<M extends HostMethod> = z.infer<(typeof hostMethods)[M]['params']>;
export type HostResult<M extends HostMethod> = z.infer<(typeof hostMethods)[M]['result']>;
export type HostNotificationName = keyof typeof hostNotifications;
export type HostNotificationParams<N extends HostNotificationName> = z.infer<(typeof hostNotifications)[N]['params']>;
