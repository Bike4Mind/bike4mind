import type {
  ChatQueueEvent,
  ChatSessionStatusEvent,
  ChatSessionSummary,
  ChatStreamEvent,
  ContextNoticeKind,
} from '@shared/chat';
import { HELD_CONTEXT_NOTICE_KINDS } from '@shared/chat';
import type { PendingTaskDecision } from '@shared/orchestration';
import {
  LOCAL_HOST_ID,
  type HostBridgeApi,
  type HostBridgeResponse,
  type HostNotificationDelivery,
} from '@shared/hostBridge';
import { HOST_ERROR_CODES, hostNotification } from '@shared/hostProtocol';
import { pageSessions, sessionPageRequestSchema } from '@shared/sessionPage';

type ChatStubs = Partial<{
  listSessions(): Promise<ChatSessionSummary[]>;
  getSessionStatuses(): Promise<ChatSessionStatusEvent[]>;
  onSessionSummary(listener: (summary: ChatSessionSummary) => void): unknown;
  onSessionStatus(listener: (event: ChatSessionStatusEvent) => void): unknown;
  // The names below are the test-side stubs a test emits through; the bridge turns each into the
  // host notification the renderer now listens to.
  onStreamEvent(listener: (event: ChatStreamEvent) => void): unknown;
  onQueueChanged(listener: (event: ChatQueueEvent) => void): unknown;
  onTaskDecisions(listener: (decisions: PendingTaskDecision[]) => void): unknown;
  listTaskDecisions(): Promise<PendingTaskDecision[]>;
}>;

type ChatStub = (...args: never[]) => unknown;
type ChatMethodStubs = Partial<Record<string, ChatStub>>;

/** The `window.b4m.chat` stubs the bridge answers from, for a test that swaps one after mounting. */
export const chatStubs = (): ChatStubs & ChatMethodStubs =>
  (window as unknown as { b4m: { chat?: ChatStubs & ChatMethodStubs } }).b4m.chat ?? {};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};

/** Stub sessions are often partial fixtures; the host protocol needs an id, which a real host always sets. */
const withId = (session: unknown, id: unknown): unknown => {
  if (session === null || session === undefined) return null;
  const fields = asRecord(session);
  return 'id' in fields ? session : { id, ...fields };
};

const TEST_EPOCH = 'test';

/** How one host method is answered from a same-named chat stub: which stub, with which old-shape arguments, and how its result is wrapped. */
type Route = {
  stub: string;
  args(params: Record<string, unknown>): unknown[];
  result(stubResult: unknown, params: Record<string, unknown>): unknown;
};

const route = (stub: string, args: Route['args'], result: Route['result'] = () => ({})): Route => ({
  stub,
  args,
  result,
});

const routeFor = (
  method: string,
  params: Record<string, unknown>,
  cursorOf: (sessionId: unknown) => { epoch: string; seq: number },
  noticesOf: (sessionId: unknown) => { kind: ContextNoticeKind; message: string }[]
): Route | undefined => {
  switch (method) {
    case 'session/get':
      return route(
        'getSession',
        p => (p.viewed === undefined ? [p.sessionId] : [p.sessionId, p.viewed]),
        (r, p) => {
          const notices = noticesOf(p.sessionId);
          return {
            session: withId(r, p.sessionId),
            cursor: cursorOf(p.sessionId),
            ...(notices.length > 0 ? { notices } : {}),
          };
        }
      );
    case 'session/create':
      return route(
        'createCodeSession',
        p => [p],
        r => r
      );
    case 'session/rename':
      return route(
        'renameSession',
        p => [p.sessionId, p.title],
        r => ({ summary: r ?? null })
      );
    case 'session/setArchived':
      return route(
        'setSessionArchived',
        p => [p.sessionId, p.archived],
        r => ({ summary: r ?? null })
      );
    case 'session/delete':
      return route('deleteSession', p => [p.sessionId, p.removeWorktree]);
    case 'session/deleteTree':
      return route(
        'deleteSessionTree',
        p => [p.sessionId, p.nestedIds, p.removeWorktree, p.nestedWorktreeIds, { allowDiscard: p.allowDiscard }],
        r => r
      );
    case 'turn/send':
      return route(
        'sendMessage',
        p => [p],
        r => r
      );
    case 'turn/stop':
      return route('stopReply', p => [p.sessionId]);
    case 'request/respond':
      return params.kind === 'taskDecision'
        ? route('answerTaskDecision', p => [p.sessionId, p.decisionId, p.answer])
        : route('respondToApproval', p => [p.requestId, p.answer]);
    case 'queue/list':
      return route(
        'getQueuedMessages',
        p => [p.sessionId],
        r => ({ queued: r })
      );
    case 'queue/cancel':
      return route('cancelQueuedMessage', p => [p.sessionId, p.queuedId]);
    case 'queue/sendNow':
      return route('sendQueuedMessageNow', p => [p.sessionId, p.queuedId]);
    case 'model/list':
      return route(
        'listModels',
        p => (p.force === undefined ? [] : [p.force]),
        r => ({ models: r })
      );
    case 'draft/defaults':
      return route(
        'defaultsForNewSession',
        () => [],
        r => ({ defaults: r })
      );
    case 'project/recent':
      return route(
        'listRecentFolders',
        () => [],
        r => ({ folders: r })
      );
    case 'project/forgetRecent':
      return route(
        'removeRecentFolder',
        p => [p.path],
        r => ({ folders: r })
      );
    case 'project/inspect':
      return route(
        'inspectProject',
        p => [p.directory],
        r => ({ inspection: r })
      );
    default:
      return undefined;
  }
};

const asUnsubscribe = (value: unknown): (() => void) =>
  typeof value === 'function' ? () => void value() : () => undefined;

/**
 * A local host bridge for renderer tests written against `window.b4m.chat` stubs: it answers the
 * host methods the renderer uses from the same-named stubs, read at call time so a test may replace
 * one after stubbing the bridge, with the stubs' old argument shapes. A method whose stub is
 * missing fails as one the host does not serve; a stub that throws fails with its message.
 * Stream events are numbered per session and reach only subscribed sessions, as a host sends them.
 */
export function chatBackedHostBridge(): HostBridgeApi {
  // One upstream subscription shared by every listener, as the real bridge's single IPC channel is.
  const listeners = new Set<(delivery: HostNotificationDelivery) => void>();
  const deliver = (delivery: HostNotificationDelivery) => listeners.forEach(listener => listener(delivery));
  let unsubscribeUpstream: () => void = () => undefined;
  const seqs = new Map<string, number>();
  const subscribed = new Set<string>();
  const cursorOf = (sessionId: unknown) => ({
    epoch: TEST_EPOCH,
    seq: typeof sessionId === 'string' ? (seqs.get(sessionId) ?? 0) : 0,
  });
  const notifyLocal = (notification: HostNotificationDelivery['notification']) =>
    deliver({ hostId: LOCAL_HOST_ID, notification });
  // The held notices in force, kept the way the host's ContextNotices keeps them.
  const heldNotices = new Map<string, Map<ContextNoticeKind, string>>();
  const holdNotice = (event: ChatStreamEvent) => {
    if (event.type === 'context-notice' && event.kind && HELD_CONTEXT_NOTICE_KINDS.includes(event.kind)) {
      const held = heldNotices.get(event.sessionId) ?? new Map<ContextNoticeKind, string>();
      heldNotices.set(event.sessionId, held.set(event.kind, event.message));
    }
    if (event.type === 'context-notice-cleared') heldNotices.get(event.sessionId)?.delete(event.kind);
  };
  const noticesOf = (sessionId: unknown) =>
    typeof sessionId === 'string'
      ? [...(heldNotices.get(sessionId) ?? [])].map(([kind, message]) => ({ kind, message }))
      : [];
  const emitStreamEvent = (event: ChatStreamEvent) => {
    holdNotice(event);
    const seq = (seqs.get(event.sessionId) ?? 0) + 1;
    seqs.set(event.sessionId, seq);
    if (subscribed.has(event.sessionId)) {
      notifyLocal(hostNotification('session/event', { sessionId: event.sessionId, seq, epoch: TEST_EPOCH, event }));
    }
    if (event.type === 'context-notice' || event.type === 'context-notice-cleared') {
      notifyLocal(hostNotification('session/contextNotice', { event }));
    }
    if (event.type === 'spawn-failed') {
      notifyLocal(
        hostNotification('session/spawnFailed', {
          sessionId: event.sessionId,
          title: event.title,
          message: event.message,
        })
      );
    }
  };
  const subscribeUpstream = () => {
    const chat = chatStubs();
    const offStream = asUnsubscribe(chat.onStreamEvent?.(emitStreamEvent));
    const offQueue = asUnsubscribe(
      chat.onQueueChanged?.(event => notifyLocal(hostNotification('session/queueChanged', { event })))
    );
    const offDecisions = asUnsubscribe(
      chat.onTaskDecisions?.(decisions => notifyLocal(hostNotification('session/taskDecisionsChanged', { decisions })))
    );
    const offSummary = asUnsubscribe(
      chat.onSessionSummary?.(summary =>
        deliver({ hostId: LOCAL_HOST_ID, notification: hostNotification('session/summaryChanged', { summary }) })
      )
    );
    const offStatus = asUnsubscribe(
      chat.onSessionStatus?.(event =>
        deliver({ hostId: LOCAL_HOST_ID, notification: hostNotification('session/statusChanged', { event }) })
      )
    );
    return () => {
      offStream();
      offQueue();
      offDecisions();
      offSummary();
      offStatus();
    };
  };
  return {
    async request(hostId, method, params): Promise<HostBridgeResponse> {
      const chat = chatStubs();
      if (hostId === LOCAL_HOST_ID && method === 'session/list') {
        return { ok: true, result: { sessions: (await chat.listSessions?.()) ?? [] } };
      }
      // Paged the way the host pages it, over whatever the test's listSessions stub returns. Ties
      // keep the stub's order, as SessionStore.list's stable sort does.
      if (hostId === LOCAL_HOST_ID && method === 'session/page') {
        const all = [...((await chat.listSessions?.()) ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { ok: true, result: pageSessions(all, sessionPageRequestSchema.parse(params)) };
      }
      if (hostId === LOCAL_HOST_ID && method === 'session/statuses') {
        return { ok: true, result: { statuses: (await chat.getSessionStatuses?.()) ?? [] } };
      }
      if (hostId === LOCAL_HOST_ID && method === 'taskDecision/list') {
        return { ok: true, result: { decisions: (await chat.listTaskDecisions?.()) ?? [] } };
      }
      const sessionId = asRecord(params).sessionId;
      if (hostId === LOCAL_HOST_ID && method === 'session/subscribe' && typeof sessionId === 'string') {
        subscribed.add(sessionId);
        return { ok: true, result: { cursor: cursorOf(sessionId) } };
      }
      if (hostId === LOCAL_HOST_ID && method === 'session/unsubscribe' && typeof sessionId === 'string') {
        subscribed.delete(sessionId);
        return { ok: true, result: {} };
      }
      const matched = hostId === LOCAL_HOST_ID ? routeFor(method, asRecord(params), cursorOf, noticesOf) : undefined;
      const stub = matched && chat[matched.stub];
      if (!matched || !stub) {
        return { ok: false, error: { code: HOST_ERROR_CODES.methodNotFound, message: `Not faked: ${method}` } };
      }
      try {
        return {
          ok: true,
          result: matched.result(
            await Reflect.apply(stub, undefined, matched.args(asRecord(params))),
            asRecord(params)
          ),
        };
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return { ok: false, error: { code: HOST_ERROR_CODES.internalError, message } };
      }
    },
    onNotification(listener) {
      listeners.add(listener);
      if (listeners.size === 1) unsubscribeUpstream = subscribeUpstream();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) unsubscribeUpstream();
      };
    },
  };
}
