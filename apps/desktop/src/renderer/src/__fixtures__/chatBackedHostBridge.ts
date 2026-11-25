import type { ChatSessionStatusEvent, ChatSessionSummary } from '@shared/chat';
import {
  LOCAL_HOST_ID,
  type HostBridgeApi,
  type HostBridgeResponse,
  type HostNotificationDelivery,
} from '@shared/hostBridge';
import { HOST_ERROR_CODES, hostNotification } from '@shared/hostProtocol';

type ChatStubs = Partial<{
  listSessions(): Promise<ChatSessionSummary[]>;
  getSessionStatuses(): Promise<ChatSessionStatusEvent[]>;
  onSessionSummary(listener: (summary: ChatSessionSummary) => void): unknown;
  onSessionStatus(listener: (event: ChatSessionStatusEvent) => void): unknown;
}>;

type ChatStub = (...args: unknown[]) => unknown;
type ChatMethodStubs = Partial<Record<string, ChatStub>>;

const chatStubs = (): ChatStubs & ChatMethodStubs =>
  (window as unknown as { b4m: { chat?: ChatStubs & ChatMethodStubs } }).b4m.chat ?? {};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};

/** Stub sessions are often partial fixtures; the host protocol needs an id, which a real host always sets. */
const withId = (session: unknown, id: unknown): unknown => {
  if (session === null || session === undefined) return null;
  const fields = asRecord(session);
  return 'id' in fields ? session : { id, ...fields };
};

const TEST_CURSOR = { epoch: 'test', seq: 0 };

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

const routeFor = (method: string, params: Record<string, unknown>): Route | undefined => {
  switch (method) {
    case 'session/get':
      return route(
        'getSession',
        p => (p.viewed === undefined ? [p.sessionId] : [p.sessionId, p.viewed]),
        (r, p) => ({ session: withId(r, p.sessionId), cursor: TEST_CURSOR })
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
        p => [p.sessionId, p.nestedIds, p.removeWorktree, p.nestedWorktreeIds],
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
 */
export function chatBackedHostBridge(): HostBridgeApi {
  // One upstream subscription shared by every listener, as the real bridge's single IPC channel is.
  const listeners = new Set<(delivery: HostNotificationDelivery) => void>();
  const deliver = (delivery: HostNotificationDelivery) => listeners.forEach(listener => listener(delivery));
  let unsubscribeUpstream: () => void = () => undefined;
  const subscribeUpstream = () => {
    const chat = chatStubs();
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
      if (hostId === LOCAL_HOST_ID && method === 'session/statuses') {
        return { ok: true, result: { statuses: (await chat.getSessionStatuses?.()) ?? [] } };
      }
      const matched = hostId === LOCAL_HOST_ID ? routeFor(method, asRecord(params)) : undefined;
      const stub = matched && chat[matched.stub];
      if (!matched || !stub) {
        return { ok: false, error: { code: HOST_ERROR_CODES.methodNotFound, message: `Not faked: ${method}` } };
      }
      try {
        return { ok: true, result: matched.result(await stub(...matched.args(asRecord(params))), asRecord(params)) };
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
