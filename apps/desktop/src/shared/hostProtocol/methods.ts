import { z, type ZodType } from 'zod';
import { CONTEXT_NOTICE_KINDS } from '../chat';
import { sessionPageRequestSchema } from '../sessionPage';
import { eventCursorSchema } from './cursor';
import { hostProtocolVersionSchema, hostCapabilitiesSchema } from './version';
import {
  backgroundProcessPayloadSchema,
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
  projectInspectionPayloadSchema,
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

const recentFoldersResult = z.object({ folders: z.array(z.object({ path: z.string(), name: z.string() })) });

/** The facts a client shows before archiving a parent; `status` stays a string so a newer host may add one. */
export const archiveConfirmationSchema = z.object({
  parentTitle: z.string(),
  finished: z.array(z.object({ id: z.string(), title: z.string() })),
  kept: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
});

/**
 * The `data` of the protocol's method-specific errors (see HOST_ERROR_CODES). `reason` is a
 * string for the same reason: a newer host may report one this client has not seen.
 */
export const hostErrorData = {
  pathUnavailable: z.object({ path: z.string(), reason: z.string() }),
  processNotFound: z.object({ sessionId: z.string(), processId: z.string() }),
} as const satisfies Record<string, ZodType>;
export type HostErrorData<K extends keyof typeof hostErrorData> = z.infer<(typeof hostErrorData)[K]>;

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

const contextNoticeKindSchema = z.enum(CONTEXT_NOTICE_KINDS);

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
  // The sidebar's paged view of session/list; see shared/sessionPage.
  'session/page': {
    params: sessionPageRequestSchema,
    result: z.object({
      sessions: z.array(chatSessionSummaryPayloadSchema),
      related: z.array(chatSessionSummaryPayloadSchema),
      nextCursor: z.string().nullable(),
      total: z.number().int().nonnegative(),
    }),
  },
  'session/get': {
    params: z.object({ sessionId: z.string(), viewed: z.boolean().optional() }),
    // `notices` (since 1.3) are the held context notices in force, for re-seeding a banner
    // after a reconnect; absent when there are none.
    result: z.object({
      session: chatSessionPayloadSchema.nullable(),
      cursor: eventCursorSchema,
      notices: z.array(z.object({ kind: contextNoticeKindSchema, message: z.string() })).optional(),
    }),
  },
  // Absent params start a plain chat session, like chatCreateSession; the reply is the Code
  // session's result shape, with a plain chat session reported as ok: true. Sidebar placement
  // is the client's own, so the request carries no section.
  'session/create': {
    params: createCodeSessionRequestPayloadSchema.optional(),
    result: createCodeSessionResultPayloadSchema,
  },
  'session/rename': {
    params: z.object({ sessionId: z.string(), title: z.string() }),
    result: z.object({ summary: chatSessionSummaryPayloadSchema.nullable() }),
  },
  // Archiving a parent with live sub-sessions changes nothing until `confirmed`; until then the
  // result has a null summary and the question in `confirmationRequired`. `archiveChildIds` are
  // the finished sub-sessions the user chose to archive with it, each rechecked by the host.
  'session/setArchived': {
    params: z.object({
      sessionId: z.string(),
      archived: z.boolean(),
      confirmed: z.boolean().optional(),
      archiveChildIds: z.array(z.string()).optional(),
    }),
    result: z.object({
      summary: chatSessionSummaryPayloadSchema.nullable(),
      confirmationRequired: archiveConfirmationSchema.optional(),
    }),
  },
  // `allowDiscard` lets worktree cleanup discard uncommitted or unpushed work, keeping the branch;
  // send it only after showing the user what that loses (since 1.2).
  'session/delete': {
    params: z.object({
      sessionId: z.string(),
      removeWorktree: z.boolean().optional(),
      allowDiscard: z.boolean().optional(),
    }),
    result: emptyResult,
  },
  // Deletes `nestedIds` deepest first, then the session; `removeWorktree` is the session's own
  // worktree and `nestedWorktreeIds` the nested sessions whose worktrees go too; cleanup may discard
  // work in each, so send it only after showing what that loses. `error` names the first failure,
  // after which nothing more is deleted (since 1.2).
  'session/deleteTree': {
    params: z.object({
      sessionId: z.string(),
      nestedIds: z.array(z.string()),
      removeWorktree: z.boolean().optional(),
      nestedWorktreeIds: z.array(z.string()).optional(),
      allowDiscard: z.boolean().optional(),
    }),
    result: z.object({ deleted: z.array(z.string()), error: z.string().nullable() }),
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
  // An unknown process fails with processNotFound; one that had already ended comes back as it is.
  'background/stop': {
    params: z.object({ sessionId: z.string(), processId: z.string() }),
    result: z.object({ process: backgroundProcessPayloadSchema.optional() }),
  },
  // Directories only, never file contents; an absent path means the host's home directory, and
  // `~` or a relative path is taken from it. A path that is missing, not a directory or not
  // readable fails with pathUnavailable. `truncated` says the entry cap cut the list.
  // Params are optional since 1.2.
  'fs/browse': {
    params: z.object({ path: z.string().optional() }).optional(),
    result: z.object({
      path: z.string(),
      parent: z.string().nullable(),
      entries: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          isGitRepository: z.boolean(),
          isHidden: z.boolean().optional(),
          isSymlink: z.boolean().optional(),
        })
      ),
      truncated: z.boolean().optional(),
    }),
  },
  'project/recent': { params: noParams, result: recentFoldersResult },
  // Replies with the list as it now stands.
  'project/forgetRecent': { params: z.object({ path: z.string() }), result: recentFoldersResult },
  // What a folder offers a new Code session: whether it is a repository, and its branches.
  'project/inspect': {
    params: z.object({ directory: z.string() }),
    result: z.object({ inspection: projectInspectionPayloadSchema }),
  },
  'model/list': {
    params: z.object({ force: z.union([z.boolean(), z.literal('local')]).optional() }),
    result: z.object({ models: chatModelCatalogPayloadSchema }),
  },
  'draft/defaults': { params: noParams, result: z.object({ defaults: newSessionDefaultsPayloadSchema }) },
  // Every decision a worker in the signed-in account waits on the user for; what
  // session/taskDecisionsChanged then replaces in full (since 1.3).
  'taskDecision/list': {
    params: noParams,
    result: z.object({ decisions: z.array(pendingTaskDecisionPayloadSchema) }),
  },
} as const satisfies Record<string, { params: ZodType; result: ZodType }>;

/** The context-notice and context-notice-cleared stream events (ChatStreamEvent). */
const contextNoticeEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('context-notice'),
    sessionId: z.string(),
    message: z.string(),
    kind: contextNoticeKindSchema.optional(),
  }),
  z.object({ type: z.literal('context-notice-cleared'), sessionId: z.string(), kind: contextNoticeKindSchema }),
]);

/*
 * session/event goes only to the connections subscribed to its session, in seq order; `epoch` with
 * `seq` is the event's cursor (epoch since 1.3; a 1.2 host leaves it out). The rest go to every
 * connection. The queue and task-decision notifications carry their whole current state, so the
 * next one repairs a missed one, and a client re-reads both (queue/list, taskDecision/list) after
 * a resync.
 */
export const hostNotifications = {
  'session/event': {
    params: z.object({
      sessionId: z.string(),
      seq: z.number().int().nonnegative(),
      epoch: z.string().min(1).optional(),
      event: chatStreamEventPayloadSchema,
    }),
  },
  // A session that failed to start, sent whether or not anyone is subscribed to it: the session
  // may already be gone, and the sidebar re-reads its list on (re)connect rather than relying on
  // this (since 1.3).
  'session/spawnFailed': {
    params: z.object({ sessionId: z.string(), title: z.string(), message: z.string() }),
  },
  // A session's context notice set or withdrawn, sent to every connection whether or not it is
  // subscribed, so a window learns of a session it is not showing (since 1.3). The same notice
  // still rides in session/event for 1.2 clients; a 1.3 client takes notices from here only.
  'session/contextNotice': { params: z.object({ event: contextNoticeEventSchema }) },
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
