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

const chatStubs = (): ChatStubs => (window as unknown as { b4m: { chat?: ChatStubs } }).b4m.chat ?? {};

const asUnsubscribe = (value: unknown): (() => void) =>
  typeof value === 'function' ? () => void value() : () => undefined;

/**
 * A local host bridge for renderer tests written against `window.b4m.chat` stubs: it answers the
 * host methods the session list uses from those stubs, read at call time so a test may replace
 * one after stubbing the bridge. Any other method fails as one the host does not serve.
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
    async request(hostId, method): Promise<HostBridgeResponse> {
      const chat = chatStubs();
      if (hostId === LOCAL_HOST_ID && method === 'session/list') {
        return { ok: true, result: { sessions: (await chat.listSessions?.()) ?? [] } };
      }
      if (hostId === LOCAL_HOST_ID && method === 'session/statuses') {
        return { ok: true, result: { statuses: (await chat.getSessionStatuses?.()) ?? [] } };
      }
      return { ok: false, error: { code: HOST_ERROR_CODES.methodNotFound, message: `Not faked: ${method}` } };
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
